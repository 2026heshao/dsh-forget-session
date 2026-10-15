/**
 * dsh-forget-session — Host 半（Cordis 插件）v2。
 *
 * 一个 TypertRemoteService：浏览器半通过 `ctx.remote.$mount(...)` 挂载本服务的
 * 契约后，经 `ctx.get('remote.forgetSession').<method>(payload)` 调到这里。
 *
 * 「删除一个会话」分两层：
 *
 *  A. 权威状态（全走官方通道，绝不手改 workspace.json）：
 *    1. 停工作 + 临时归档：`registry.archiveSession(id, { stopActivity: true })`
 *    2. 摘归档：`registry.unarchiveSession(id)`
 *    3. 摘置顶：`registry.unpinSession(id)`
 *    4. 摘记账：对每个含它的 workspace 实体 `entity.detachSession(id)`
 *    5. 活体处置：先 `sessions.flush(id)` 落盘缓冲事件，再删文件。
 *
 *  B. 磁盘文件（会话日志目录 + 投影缓存分片/总表项）：
 *    - 会话日志目录：`~/.dsh/sessions/<projectKey(cwd)>/<id>`（与
 *      session-persistence-jsonl 的 `projectKey`/`encodeSegment` 完全同构，
 *      含 `_no-cwd` 项目目录与 v0/vN 世代文件）。
 *    - 投影缓存分片：`~/.dsh/storages/session_projcache/sessions/<id>.json`
 *    - 投影缓存总表：`~/.dsh/storages/session_projcache.json` 的
 *      `tables.sessions[<id>]`（读-改-写，保持其余内容不变）。
 *
 * v2 修复的「已删会话复活」根因：
 *
 *  1. Windows 活体删除竞态：会话打开过就有 write handle / 跨进程 lease，
 *     `rm` 报 EBUSY/EPERM 而 v1 静默失败 → 文件残留 → 重启后 registry 重新
 *     收编进「未分组」；且删除后活体 teardown 的迟到 append 会重建已删目录。
 *     v2 在删除后**验证性复查**，占用类错误退避重试，并布置「复活守卫」：
 *     删除成功后约 2 分钟内周期复查，目录被重建立即再删。
 *  2. 删除前先 flush 活体缓冲事件，避免「删盘后缓冲区又写回」。
 *
 * 记忆安全：灵枢记忆的数据在 `~/.dsh/.dsh-memory`，与本插件删除的文件不相交。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as zlib from "node:zlib";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** 分片投影缓存里单会话文件所在子目录。 */
const PROJCACHE_SHARD_DIR = ["storages", "session_projcache", "sessions"];
/** 投影缓存总表文件（storage-domain 的 sessions 表）。 */
const PROJCACHE_JSON = ["storages", "session_projcache.json"];
/** 世代日志文件名：`session.vN.jsonl[.zstd]` / v0 `session.jsonl[.zstd]`。 */
/** 复活守卫：复查间隔（ms），指数退避 ×2，总窗约 2 分钟。 */
const GUARD_BASE_DELAY_MS = 2_000;
const GUARD_MAX_DELAY_MS = 32_000;
const GUARD_TOTAL_MS = 130_000;
/** 删除失败（EBUSY 等）时的重试间隔基数（ms）与次数。 */
const RETRY_BASE_DELAY_MS = 1_500;
const RETRY_MAX_ATTEMPTS = 3;

/** 活跃的复活守卫：sessionId → 定时器。模块级全局，服务重建不叠加。 */
const resurrectionGuards = new Map();

/**
 * 与 session-persistence-jsonl `encodeSegment` 同构：任意字符串 → 安全路径段。
 * @param {string} raw - 原始段（会话 id）。
 * @returns {string} 文件系统安全的段。
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

/**
 * 与 session-persistence-jsonl `projectKey` 同构：项目目录 → 人类可读目录名。
 * @param {string} cwd - 会话的项目目录（绝对路径）。
 * @returns {string} sessions 根下的项目目录名。
 */
function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * 一个会话在 sessions 根下可能存在的目录。
 * cwd 已知 → `join(projectKey(cwd), encodeSegment(id))`；cwd 未知 → 扫全部
 * 项目目录（含 `_no-cwd`，它也是根下的普通目录）。
 * @param {string} sessionsRoot - DSH 会话存储根。
 * @param {string|undefined} cwd - 会话头里的 cwd。
 * @param {string} id - 会话 id。
 * @returns {Promise<string[]>} 可能存在的会话目录绝对路径。
 */
async function candidateSessionDirs(sessionsRoot, cwd, id) {
	const encoded = encodeSegment(id);
	if (cwd !== undefined && cwd !== "") {
		return [join(sessionsRoot, projectKey(cwd), encoded)];
	}
	const dirs = [];
	try {
		for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			dirs.push(join(sessionsRoot, entry.name, encoded));
		}
	} catch {
		// 根不存在 → 没有文件可删
	}
	return dirs;
}







/** 是否为「文件占用」类错误（Windows EBUSY/EPERM/ENOTEMPTY 重试可救）。 */
function isBusyError(error) {
	const message = errorMessage(error);
	return /\b(EBUSY|EPERM|ENOTEMPTY)\b/i.test(message) || /being used by another process/i.test(message);
}

/** 删除一个目录（占用类错误按退避重试），返回是否确实消失。 */
async function removeDirWithRetry(dir) {
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			if (!existsSync(dir)) return true;
			await rm(dir, { recursive: true, force: true });
			return !existsSync(dir);
		} catch (error) {
			if (attempt === RETRY_MAX_ATTEMPTS || !isBusyError(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
		}
	}
	return false;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * DSH 数据根（`~/.dsh` 的上一级）。优先 `DSH_FORGET_SESSION_HOME`（测试隔离用），
 * 否则 OS 家目录（dsh-home-paths 约定：会话/存储在 `<home>/.dsh` 下）。
 * @returns {string} 家目录绝对路径。
 */
function resolveHome() {
	const override = process.env.DSH_FORGET_SESSION_HOME;
	if (override !== undefined && override !== "") return override;
	return homedir();
}

var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = !target ? void 0 : Object.getOwnPropertyDescriptor(target, contextIn.name);
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(result.init);
		} else if (kind === "method") {
			// Remote(name) 装饰器（本插件的用法）：method 装饰不返回替换值，
			// result 为 undefined 时保持原方法即可（官方 __esDecorate 的
			// `typeof result === "function" ? _ = result : _ = result[key]`
			// 分支在 method 无替换值时静默跳过）。
			if (typeof result === "function") descriptor[key] = result;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

let ForgetSessionGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _delete_decorators;
	return class ForgetSessionGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _delete_decorators, { kind: "method", name: "delete", static: false, private: false, access: { has: (obj) => "delete" in obj, get: (obj) => obj.delete }, metadata: _metadata }, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
		}
		// 声明式注入：与官方 @deepseek-ai/dsh-api-workspace-controller 同款。
		// Cordis 会等服务就绪后再实例化本服务，这也是「`ctx.x` 属性访问合法」
		// 的前提 —— 未声明的服务用属性访问会被 Proxy 直接抛
		// `cannot get property "x" without inject`。
		static inject = ["workspaceRegistry"];
		constructor(ctx) {
			super(ctx, "forgetSession");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		 * 解析 workspace 注册表。
		 *
		 * 用 `ctx.get()` 这个**宽松入口**（官方 dsh-workspace 取 `sessions` 用的
		 * 就是它）：服务缺失时返回 undefined 而非抛错，我们据此给出可读错误让
		 * 前端显示出来。正常情况下上面的 `static inject` 已保证它存在。
		 */
		requireRegistry() {
			const ctx = this.ctx;
			const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
			if (registry === undefined || registry === null) {
				throw new Error("workspaceRegistry service is unavailable (workspace plugin not loaded)");
			}
			return registry;
		}

		// ════════════════════ 远端方法：delete ════════════════════

		/** 删除一个会话（权威状态 + 磁盘工件 + 复活守卫）。幂等。 */
		async delete(payload) {
			const sessionId = this.requireSessionId(payload);
			const removed = {
				sessionId,
				stoppedWork: false,
				detached: false,
				unarchived: false,
				unpinned: false,
				flushed: false,
				filesRemoved: [],
				projcacheShard: false,
				projcacheJson: false,
				guardScheduled: false,
				warnings: []
			};
			const registry = this.requireRegistry();

			// ── 0. 读头拿 cwd（动任何状态之前）───────────────────────────
			let cwd;
			try {
				const header = await registry.readSessionHeader(sessionId);
				cwd = header?.cwd;
			} catch (error) {
				removed.warnings.push(`read header: ${errorMessage(error)}`);
			}

			// ── 1. 停工作（官方 stopActivity 归档路径，临时态）───────────
			try {
				await registry.archiveSession(sessionId, { stopActivity: true });
				removed.stoppedWork = true;
			} catch (error) {
				const message = errorMessage(error);
				if (!/unknown session/i.test(message)) removed.warnings.push(`stop activity: ${message}`);
			}

			// ── 2. 摘归档（撤掉第 1 步的临时归档）────────────────────────
			try {
				await registry.unarchiveSession(sessionId);
				removed.unarchived = true;
			} catch (error) {
				removed.warnings.push(`unarchive: ${errorMessage(error)}`);
			}

			// ── 3. 摘置顶 ────────────────────────────────────────────────
			try {
				await registry.unpinSession(sessionId);
				removed.unpinned = true;
			} catch (error) {
				removed.warnings.push(`unpin: ${errorMessage(error)}`);
			}

			// ── 4. 活体 flush（把缓冲事件落盘，随后我们删盘）────────────
			try {
				const sessions = this.ctx.get("sessions");
				const live = sessions?.get?.(sessionId);
				if (live !== undefined) {
					try { await sessions.flush?.(live); removed.flushed = true; } catch { /* flush 失败不阻断删除 */ }
				}
			} catch (error) {
				removed.warnings.push(`live flush: ${errorMessage(error)}`);
			}

			// ── 5. 摘工作区记账（官方 detach 通道）──────────────────────
			try {
				for (const entity of registry.list()) {
					const ids = entity.sessionIds;
					if (Array.isArray(ids) && ids.includes(sessionId)) {
						await entity.detachSession(sessionId);
						removed.detached = true;
					}
				}
			} catch (error) {
				removed.warnings.push(`detach: ${errorMessage(error)}`);
			}

			// ── 6. 删磁盘会话目录（占用类错误退避重试 + 验证性复查）────
			const home = resolveHome();
			const sessionsRoot = join(home, ".dsh", "sessions");
			const candidates = await candidateSessionDirs(sessionsRoot, cwd, sessionId);
			for (const dir of candidates) {
				if (!existsSync(dir)) continue;
				try {
					const ok = await removeDirWithRetry(dir);
					if (ok) removed.filesRemoved.push(dir);
					else removed.warnings.push(`rm ${dir}: file still present after retries (held by a live handle?)`);
				} catch (error) {
					removed.warnings.push(`rm ${dir}: ${errorMessage(error)}`);
				}
			}

			// ── 7. 清投影缓存（分片 + 总表项）───────────────────────────
			await this.cleanProjectionCache(home, sessionId, removed);

			// ── 8. 复活守卫：无论本轮是否全清，接下来 ~2 分钟内周期复查。
			//       覆盖两类复活：a) EBUSY 残留（活体 handle 释放后补删）；
			//       b) 活体 teardown 迟到 append 重建的目录。
			this.scheduleResurrectionGuard(sessionId, cwd, removed);

			return { ok: true, removed };
		}

		// ════════════════════ 内部工具 ════════════════════

		

		/** 停掉一个会话的复活守卫。 */
		stopGuard(sessionId) {
			const guard = resurrectionGuards.get(sessionId);
			if (guard !== undefined) {
				clearTimeout(guard);
				resurrectionGuards.delete(sessionId);
			}
		}

		/**
		 * 布置复活守卫：2s 起、×2 退避、总窗 ~130s，每档复查目录与分片，
		 * 被重建就再删。该会话再次被显式删除会重置守卫。
		 */
		scheduleResurrectionGuard(sessionId, cwd, removed) {
			this.stopGuard(sessionId);
			const startedAt = Date.now();
			let delay = GUARD_BASE_DELAY_MS;
			const tick = async () => {
				try {
					const home = resolveHome();
					const sessionsRoot = join(home, ".dsh", "sessions");
					const dirs = await candidateSessionDirs(sessionsRoot, cwd, sessionId);
					let removedAny = false;
					for (const dir of dirs) {
						if (!existsSync(dir)) continue;
						try {
							if (await removeDirWithRetry(dir)) removedAny = true;
						} catch { /* 仍被占用，等下一档 */ }
					}
					if (removedAny) {
						const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
						try { if (existsSync(shard)) await rm(shard, { force: true }); } catch { /* 忽略 */ }
					}
				} catch { /* 文件系统抖动，下一档再看 */ }
				const nextDelay = delay * 2;
				if (Date.now() - startedAt + nextDelay > GUARD_TOTAL_MS) {
					resurrectionGuards.delete(sessionId);
					return;
				}
				delay = Math.min(nextDelay, GUARD_MAX_DELAY_MS);
				resurrectionGuards.set(sessionId, setTimeout(tick, delay));
			};
			if (removed) removed.guardScheduled = true;
			resurrectionGuards.set(sessionId, setTimeout(tick, delay));
		}

		/** 校验 payload 并取出会话 id。 */
		requireSessionId(payload) {
			const id = String(payload?.sessionId ?? "");
			if (id === "") throw new Error("sessionId is required");
			return id;
		}

		

		/** 清投影缓存（分片 + 总表项）。 */
		async cleanProjectionCache(home, sessionId, removed) {
			const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
			try {
				if (existsSync(shard)) {
					await rm(shard, { force: true });
					removed.projcacheShard = true;
				}
			} catch (error) {
				removed.warnings.push(`projcache shard: ${errorMessage(error)}`);
			}
			const jsonPath = join(home, ".dsh", ...PROJCACHE_JSON);
			try {
				if (!existsSync(jsonPath)) return;
				const raw = await readFile(jsonPath, "utf8");
				const parsed = JSON.parse(raw);
				const table = parsed?.tables?.sessions;
				if (table && Object.prototype.hasOwnProperty.call(table, sessionId)) {
					delete table[sessionId];
					// 原样缩进（该文件是 1 空格缩进）写回；失败只记警告。
					await writeFile(jsonPath, JSON.stringify(parsed, null, 1), "utf8");
					removed.projcacheJson = true;
				}
			} catch (error) {
				removed.warnings.push(`projcache json: ${errorMessage(error)}`);
			}
		}
	};
})();

export { ForgetSessionGateway, ForgetSessionGateway as default };
