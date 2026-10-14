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
 * v2 修复的三个「已删会话复活」根因：
 *
 *  1. sweepShells 曾引用未导入的 `zlib` → 空壳清扫对 zstd 日志恒抛
 *     ReferenceError 且被 catch 吞掉 → 空壳从未真正被清掉，重启后回到
 *     「未分组」。v2 显式 `import * as zlib from "node:zlib"`，并把世代文件
 *     选择改为「版本号最高者」，多世代目录不再误判。
 *  2. Windows 活体删除竞态：会话的 write handle 打开时 `rm` 报 EBUSY/EPERM，
 *     目录删不掉 → 重启后重新收编。v2 在删除后**验证性复查**，失败按退避
 *     重试，并布置「复活守卫」：删除成功后的 ~2 分钟内周期性复查目录，被
 *     活体 teardown 的迟到 append 重建时立刻再删。
 *  3. 客户端复活：Host 的 `session.list` 仍会列出活体会话，客户端任何一次
 *     `refreshList`（如重连）都会把行合并回来。v2 提供 `verify` 远端方法
 *     （复查 + 补删 + 报告复活），浏览器半在删除后 +4s/+20s 各复查一次并
 *     主动调用官方 `sessions.refresh()` 重对齐列表。
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
const GENERATION_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/;
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

/**
 * 列出一个会话目录里的世代日志文件名（按版本号降序，最新在前）。
 * @param {string} dir - 会话目录。
 * @returns {Promise<string[]>} 世代文件名。
 */
async function generationLogs(dir) {
	const names = (await readdir(dir)).filter((n) => GENERATION_RE.test(n));
	const versionOf = (n) => {
		const m = GENERATION_RE.exec(n);
		return m === null ? -1 : Number(m[1] ?? 0);
	};
	return names.sort((a, b) => versionOf(b) - versionOf(a));
}

/**
 * 解压**多帧** zstd 缓冲（DSH 的会话日志按落盘时机追加独立 zstd 帧）。
 * `zlib.zstdDecompressSync` 只解第一帧 —— 这曾导致把多帧日志误判为单行空壳。
 * @param {Buffer} buf - 原始 zstd 字节。
 * @returns {Buffer} 全部帧拼接的解压结果。
 */
function zstdDecompressAllFrames(buf) {
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const parts = [];
	let start = 0;
	let pos = buf.indexOf(MAGIC, 1); // 第一帧从 0 开始
	while (pos !== -1) {
		parts.push(zlib.zstdDecompressSync(buf.subarray(start, pos)));
		start = pos;
		pos = buf.indexOf(MAGIC, pos + 1);
	}
	parts.push(zlib.zstdDecompressSync(buf.subarray(start)));
	return Buffer.concat(parts);
}

/**
 * 读取一个会话目录的世代日志全文（自动识别 zstd / 明文，选最新世代）。
 * @param {string} dir - 会话目录。
 * @returns {Promise<{ text: string, bytes: number, file: string }|null>}
 *   解码结果；目录里没有世代日志时返回 null。
 */
async function readSessionLog(dir) {
	const logs = await generationLogs(dir);
	if (logs.length === 0) return null;
	const file = logs[0];
	const content = await readFile(join(dir, file));
	const text = file.endsWith(".zstd")
		? zstdDecompressAllFrames(content).toString("utf8")
		: content.toString("utf8");
	return { text, bytes: content.length, file };
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
	let _verify_decorators;
	let _sweepShells_decorators;
	let _audit_decorators;
	let _preview_decorators;
	return class ForgetSessionGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_delete_decorators = [Remote("delete")];
			_verify_decorators = [Remote("verify")];
			_sweepShells_decorators = [Remote("sweepShells")];
			_audit_decorators = [Remote("audit")];
			_preview_decorators = [Remote("preview")];
			__esDecorate(this, null, _delete_decorators, { kind: "method", name: "delete", static: false, private: false, access: { has: (obj) => "delete" in obj, get: (obj) => obj.delete }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _verify_decorators, { kind: "method", name: "verify", static: false, private: false, access: { has: (obj) => "verify" in obj, get: (obj) => obj.verify }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _sweepShells_decorators, { kind: "method", name: "sweepShells", static: false, private: false, access: { has: (obj) => "sweepShells" in obj, get: (obj) => obj.sweepShells }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _audit_decorators, { kind: "method", name: "audit", static: false, private: false, access: { has: (obj) => "audit" in obj, get: (obj) => obj.audit }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _preview_decorators, { kind: "method", name: "preview", static: false, private: false, access: { has: (obj) => "preview" in obj, get: (obj) => obj.preview }, metadata: _metadata }, null, _instanceExtraInitializers);
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

		// ════════════════════ 远端方法：verify ════════════════════

		/**
		 * 删除后的复查：报告会话工件是否仍存在；`apply:true` 时顺手补删
		 * （日志目录 + 分片缓存）。浏览器半在删除后 +4s / +20s 各调一次，
		 * 对抗活体残留与客户端列表复活。
		 */
		async verify(payload) {
			const sessionId = this.requireSessionId(payload);
			const apply = payload?.apply === true;
			const home = resolveHome();
			const sessionsRoot = join(home, ".dsh", "sessions");
			const dirs = await candidateSessionDirs(sessionsRoot, undefined, sessionId);
			const existing = dirs.filter((dir) => existsSync(dir));
			let reswept = 0;
			if (apply && existing.length > 0) {
				for (const dir of existing) {
					try {
						if (await removeDirWithRetry(dir)) reswept++;
					} catch { /* 仍被占用则留给下一次复查 */ }
				}
			}
			const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
			const existingAfter = dirs.filter((dir) => existsSync(dir));
			return {
				ok: true,
				sessionId,
				dirExists: existingAfter.length > 0,
				existingDirs: existingAfter,
				shardExists: existsSync(shard),
				reswept,
				live: this.isLive(sessionId)
			};
		}

		// ════════════════════ 远端方法：sweepShells ════════════════════

		/**
		 * 清扫空壳会话：磁盘上只有 header 帧、没有任何对话事件的会话目录。
		 *
		 * 为什么需要它：这类空壳（fork 预创建残留 / 新建后未使用的会话）不被
		 * 任何工作区记账，但文件在磁盘上 → 重启后 registry 把它们重新收编 →
		 * 侧栏出现「未分组」残影。
		 *
		 * v1 的本方法引用了未导入的 `zlib`，对 zstd 日志恒抛 ReferenceError 且
		 * 被 catch 吞掉 —— 空壳清扫从未生效过（「已删会话反复回到未分组」的主
		 * 根因之一）。v2 修复导入，并把世代文件选择改为版本号最高者。
		 */
		async sweepShells(payload = {}) {
			const apply = payload?.apply === true;
			const sessionsRoot = join(resolveHome(), ".dsh", "sessions");
			const shells = [];
			let errors = 0;
			let projects = [];
			try {
				projects = await readdir(sessionsRoot, { withFileTypes: true });
			} catch {
				return { ok: true, shells: [], swept: 0, errors: 0 };
			}
			for (const proj of projects) {
				if (!proj.isDirectory()) continue;
				const projDir = join(sessionsRoot, proj.name);
				let sessDirs = [];
				try {
					sessDirs = await readdir(projDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const sess of sessDirs) {
					if (!sess.isDirectory()) continue;
					const sessDir = join(projDir, sess.name);
					try {
						const log = await readSessionLog(sessDir);
						if (log === null) continue; // 目录里没有世代日志 → 不是会话目录
						// 体积护栏：> 4KB 的日志必含对话事件（header 帧恒 < 300B）。
						if (log.bytes >= 4096) continue;
						const lines = log.text.split("\n").filter(Boolean);
						if (lines.length === 0) continue;
						// 空壳判定：所有帧都是 header 帧（type === "session"）。
						const isShell = lines.every((l) => {
							try { return JSON.parse(l).type === "session"; } catch { return false; }
						});
						if (!isShell) continue;
						const header = JSON.parse(lines[0]);
						shells.push({ sessionId: header.id ?? sess.name, cwd: header.cwd ?? null, dir: sessDir, events: lines.length });
					} catch (error) {
						// 读取/解压失败的不碰，但上报数量便于诊断
						errors++;
						shells.push({ sessionId: sess.name, cwd: null, dir: sessDir, error: errorMessage(error) });
					}
				}
			}
			if (!apply) return { ok: true, shells, swept: 0, errors };
			let swept = 0;
			const home = resolveHome();
			for (const shell of shells) {
				if (shell.error) continue;
				try {
					if (await removeDirWithRetry(shell.dir)) swept++;
					const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${shell.sessionId}.json`);
					if (existsSync(shard)) await rm(shard, { force: true });
					this.stopGuard(shell.sessionId);
				} catch (error) {
					shell.error = errorMessage(error);
				}
			}
			return { ok: true, shells, swept, errors };
		}

		// ════════════════════ 远端方法：audit ════════════════════

		/**
		 * 体检：列出磁盘上所有会话目录的归属状态（记账 / 未记账 / 活体 /
		 * 空壳嫌疑），只读不删。用于排查「未分组」幽灵。
		 */
		async audit() {
			const sessionsRoot = join(resolveHome(), ".dsh", "sessions");
			const registry = this.requireRegistry();
			const accounted = new Set();
			for (const entity of registry.list()) {
				const ids = entity.sessionIds;
				if (Array.isArray(ids)) for (const id of ids) accounted.add(id);
			}
			const archived = new Set(registry.archivedSessionIds ?? []);
			const out = [];
			let unaccountedCount = 0;
			let projects = [];
			try {
				projects = await readdir(sessionsRoot, { withFileTypes: true });
			} catch {
				return { ok: true, sessions: [], unaccountedCount: 0 };
			}
			for (const proj of projects) {
				if (!proj.isDirectory()) continue;
				const projDir = join(sessionsRoot, proj.name);
				let sessDirs = [];
				try {
					sessDirs = await readdir(projDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const sess of sessDirs) {
					if (!sess.isDirectory()) continue;
					const sessDir = join(projDir, sess.name);
					const entry = { dir: sessDir, sessionId: sess.name, accounted: false, archived: false, live: false, shellish: null };
					try {
						const log = await readSessionLog(sessDir);
						if (log !== null) {
							const first = JSON.parse(log.text.split("\n").filter(Boolean)[0] ?? "{}");
							if (first.id) entry.sessionId = first.id;
							entry.createdAt = first.createdAt ?? null;
							entry.cwd = first.cwd ?? null;
							entry.origin = first.origin ?? null;
							entry.bytes = log.bytes;
							const lines = log.text.split("\n").filter(Boolean);
							entry.shellish = log.bytes < 4096 && lines.every((l) => { try { return JSON.parse(l).type === "session"; } catch { return false; } });
						}
					} catch (error) {
						entry.readError = errorMessage(error);
					}
					entry.accounted = accounted.has(entry.sessionId);
					entry.archived = archived.has(entry.sessionId);
					entry.live = this.isLive(entry.sessionId);
					if (!entry.accounted && !entry.live) unaccountedCount++;
					out.push(entry);
				}
			}
			return { ok: true, sessions: out, unaccountedCount };
		}

		// ════════════════════ 远端方法：preview ════════════════════

		/** 预览：只报告会话的存在状态与将删除的路径，不写任何东西。 */
		async preview(payload) {
			const id = this.requireSessionId(payload);
			const paths = await this.sessionArtifactPaths(this.requireRegistry(), id);
			return { ok: true, sessionId: id, ...paths };
		}

		// ════════════════════ 内部工具 ════════════════════

		/** 会话是否仍是本进程活体（Session store 里活着）。 */
		isLive(sessionId) {
			try {
				return this.ctx.get("sessions")?.get?.(sessionId) !== undefined;
			} catch {
				return false;
			}
		}

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

		/** 会话工件路径预览：日志目录与分片缓存。 */
		async sessionArtifactPaths(registry, sessionId) {
			let cwd;
			try {
				const header = await registry.readSessionHeader(sessionId);
				cwd = header?.cwd;
			} catch {
				cwd = undefined;
			}
			const home = resolveHome();
			const sessionsRoot = join(home, ".dsh", "sessions");
			const dirs = await candidateSessionDirs(sessionsRoot, cwd, sessionId);
			const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
			return { logDirs: dirs, projcacheShard: shard };
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
