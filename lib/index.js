/**
 * dsh-forget-session — Host 半（Cordis 插件）。
 *
 * 一个 TypertRemoteService：浏览器半通过 `ctx.remote.$mount(...)` 挂载本服务的
 * 契约后，经 `ctx.get('remote.forgetSession').delete(payload)` 调到这里的
 * `delete()`。
 *
 * 删除一个会话分两层：
 *
 *  A. 权威状态（全走官方通道，绝不手改 workspace.json）：
 *    1. 停工作 + 临时归档：`registry.archiveSession(id, { stopActivity: true })`
 *       —— 这会把仍在运行的工作按官方方式停掉（与「停止并归档」同一瀑布）。
 *    2. 摘归档：`registry.unarchiveSession(id)` —— 回到第 1 步之前的归档集合。
 *    3. 摘置顶：`registry.unpinSession(id)`。
 *    4. 摘记账：对每个含它的 workspace 实体 `entity.detachSession(id)`
 *       （官方 detach 通道，走 domain 写链并发布 domain/changed）。
 *    5. 处置活体：会话在 Session store 里活着时，`sessions.flush(id)` 落盘后
 *       记一条警告（活体摘除归它的宿主 fiber 生命周期管；UI 侧在删除前会
 *       引导用户离开该会话）。
 *
 *  B. 磁盘文件（删除后由 registry 语义收敛残留）：
 *    - 会话日志目录：`~/.dsh/sessions/<projectKey(cwd)>/<session-<id> | <id>>`
 *      与 session-persistence-jsonl 的 `projectKey`/`encodeSegment` 完全同构
 *      （含历史无前缀布局）。
 *    - 投影缓存分片：`~/.dsh/storages/session_projcache/sessions/<id>.json`
 *    - 投影缓存表项：`~/.dsh/storages/session_projcache.json` 的
 *      `tables.sessions[<id>]`（读-改-写，保持其余内容不变）。
 *
 * workspace.json 里已删 id 的残留由 registry 自身语义收敛：会话目录删除后，
 * 下次进程启动的 bootstrap / 实体 getter 的 `sessionPath(id)` 过滤会把它从
 * 记账里剪掉（本插件第 A.4 步已经先行 detach，通常没有残留）。
 *
 * 记忆安全：灵枢（@furongjun1999/dsh-memory）的沉淀走 `session/event` 事件流，
 * 数据在 `~/.dsh/.dsh-memory`，与本插件删除的文件完全不相交。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** 分片投影缓存里单会话文件所在子目录。 */
const PROJCACHE_SHARD_DIR = ["storages", "session_projcache", "sessions"];
/** 投影缓存总表文件（storage-domain 的 sessions 表）。 */
const PROJCACHE_JSON = ["storages", "session_projcache.json"];
/** 历史布局的会话目录没有 `session-` 前缀。 */
const LEGACY_PREFIX = "";

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
 * 一个会话在 sessions 根下的目录：`join(projectKey(cwd), encodeSegment(id))`。
 * 目录名 = 会话 id 原样编码（registry id 与磁盘目录严格一一对应；历史上
 * 存在过无 `session-` 前缀的 id，那时 registry 里的 id 同样无前缀，所以
 * 单变体即可命中）。cwd 未知时扫全部项目目录。
 * @param {string} sessionsRoot - DSH 会话存储根。
 * @param {string|undefined} cwd - 会话头里的 cwd。
 * @param {string} id - 会话 id。
 * @returns {Promise<string[]>} 可能存在的会话目录绝对路径。
 */
async function candidateSessionDirs(sessionsRoot, cwd, id) {
	const encoded = encodeSegment(id);
	if (cwd !== undefined) {
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
	let _preview_decorators;
	let _sweep_decorators;
	return class ForgetSessionGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_delete_decorators = [Remote("delete")];
			_preview_decorators = [Remote("preview")];
			_sweep_decorators = [Remote("sweepShells")];
			__esDecorate(this, null, _delete_decorators, { kind: "method", name: "delete", static: false, private: false, access: { has: (obj) => "delete" in obj, get: (obj) => obj.delete }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _preview_decorators, { kind: "method", name: "preview", static: false, private: false, access: { has: (obj) => "preview" in obj, get: (obj) => obj.preview }, metadata: _metadata }, null, _instanceExtraInitializers);
			__esDecorate(this, null, _sweep_decorators, { kind: "method", name: "sweepShells", static: false, private: false, access: { has: (obj) => "sweepShells" in obj, get: (obj) => obj.sweepShells }, metadata: _metadata }, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
		}
		// 声明式注入：与官方 @deepseek-ai/dsh-api-workspace-controller 同款
		// （`static inject = ["typert", "workspaceRegistry"]`）。Cordis 会等服务就绪
		// 后再实例化本服务，这也是「`ctx.x` 属性访问合法」的前提 —— 未声明的服务
		// 用属性访问会被 Proxy 直接抛 `cannot get property "x" without inject`。
		static inject = ["workspaceRegistry"];
		constructor(ctx) {
			super(ctx, "forgetSession");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		 * 解析 workspace 注册表。
		 *
		 * 用 `ctx.get()` 这个**宽松入口**（官方 dsh-workspace 取 `sessions` 用的就是它）：
		 * 服务缺失时返回 undefined 而非抛错，我们据此给出可读错误让前端显示出来。
		 * 正常情况下上面的 `static inject` 已保证它存在。
		 *
		 * @returns {object} 注册表服务。
		 * @throws {Error} 服务不可用时抛出可读错误。
		 */
		requireRegistry() {
			const ctx = this.ctx;
			const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
			if (registry === undefined || registry === null) {
				throw new Error("workspaceRegistry service is unavailable (workspace plugin not loaded)");
			}
			return registry;
		}
		/**
		 * 清扫空壳会话：磁盘上只有 header 帧、没有任何对话事件的会话目录。
		 *
		 * 为什么需要它：这类空壳（fork 预创建残留 / 新建后未使用的会话）不被任何
		 * 工作区记账，但文件在磁盘上 → 重启后 registry bootstrap / 会话目录会把
		 * 它们重新收编 → 侧栏出现「未分组」残影。逐个删除可清，但会随时间再积累，
		 * 故提供一次性的批量清扫。
		 *
		 * @param {object} payload - `{ apply?: boolean }`。apply 缺省 = 只扫描不删。
		 * @returns {{ ok: true, shells: Array, swept: number }} shells 为空壳清单。
		 */
		async sweepShells(payload = {}) {
			const apply = payload?.apply === true;
			const sessionsRoot = join(resolveHome(), ".dsh", "sessions");
			const shells = [];
			// registry 的 headers 索引可用于快速判断记账；但空壳判定只看磁盘内容，
			// 与记账解耦（记账里本来就没有它们）。
			const { readdir } = await import("node:fs/promises");
			let projects = [];
			try {
				projects = await readdir(sessionsRoot, { withFileTypes: true });
			} catch {
				return { ok: true, shells: [], swept: 0 };
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
					let logFiles = [];
					try {
						logFiles = (await readdir(sessDir)).filter((n) => n.startsWith("session."));
					} catch {
						continue;
					}
					if (logFiles.length === 0) continue;
					try {
						const content = await readFile(join(sessDir, logFiles[0]));
						const text = logFiles[0].endsWith(".zstd")
							? zstdDecompressAllFrames(content).toString("utf8")
							: content.toString("utf8");
						const lines = text.split("\n").filter(Boolean);
						// 空壳判定：**至少两帧内容且**所有帧都是 header 帧（type === "session"）。
						// 单帧只含 header 属于正常形态之一（日志按落盘时机分帧，首帧恒为 header），
						// 真正的空壳是「解出的全部行只有 header、没有任何对话事件」。
						// 另加体积护栏：> 4KB 的日志必含对话事件（header 帧恒 < 300B），直接跳过。
						const isShell = lines.length > 0
							&& content.length < 4096
							&& lines.every((l) => {
								try { return JSON.parse(l).type === "session"; } catch { return false; }
							});
						if (!isShell) continue;
						const header = JSON.parse(lines[0]);
						shells.push({ sessionId: header.id ?? sess.name, cwd: header.cwd ?? null, dir: sessDir, events: lines.length });
					} catch (error) {
						// 读取/解压失败的不碰
						shells.push({ sessionId: sess.name, cwd: null, dir: sessDir, error: errorMessage(error) });
					}
				}
			}
			if (!apply) return { ok: true, shells, swept: 0 };
			let swept = 0;
			for (const shell of shells) {
				if (shell.error) continue;
				try {
					await rm(shell.dir, { recursive: true, force: true });
					swept++;
					const shard = join(resolveHome(), ".dsh", ...PROJCACHE_SHARD_DIR, `${shell.sessionId}.json`);
					if (existsSync(shard)) await rm(shard, { force: true });
				} catch (error) {
					shell.error = errorMessage(error);
				}
			}
			return { ok: true, shells, swept };
		}
		/**
		 * 预览：只报告会话的存在状态与将删除的路径，不写任何东西。
		 * @param {object} payload - `{ sessionId }`。
		 */
		async preview(payload) {
			const id = this.requireSessionId(payload);
			const paths = await this.sessionArtifactPaths(this.requireRegistry(), id);
			return { ok: true, sessionId: id, ...paths };
		}
		/** 删除一个会话（见模块头注）。幂等：目标缺失的每步按 no-op 处理。 */
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
				warnings: []
			};
			const registry = this.requireRegistry();

			// ── 0. 读头拿 cwd（动任何状态之前）───────────────────────────────
			let cwd;
			try {
				const header = await registry.readSessionHeader(sessionId);
				cwd = header?.cwd;
			} catch (error) {
				removed.warnings.push(`read header: ${errorMessage(error)}`);
			}

			// ── 1. 停工作（官方 stopActivity 归档路径，临时态）───────────────
			try {
				await registry.archiveSession(sessionId, { stopActivity: true });
				removed.stoppedWork = true;
			} catch (error) {
				const message = errorMessage(error);
				if (!/unknown session/i.test(message)) {
					removed.warnings.push(`stop activity: ${message}`);
				}
			}

			// ── 2. 摘归档（撤掉第 1 步的临时归档）────────────────────────────
			try {
				await registry.unarchiveSession(sessionId);
				removed.unarchived = true;
			} catch (error) {
				removed.warnings.push(`unarchive: ${errorMessage(error)}`);
			}

			// ── 3. 摘置顶 ────────────────────────────────────────────────────
			try {
				await registry.unpinSession(sessionId);
				removed.unpinned = true;
			} catch (error) {
				removed.warnings.push(`unpin: ${errorMessage(error)}`);
			}

			// ── 4. 活体 flush ────────────────────────────────────────────────
			//
			// 会话若在本进程是活体（说明它被打开过），先把缓冲事件落盘再删文件。
			// 活体对象的摘除交给它的宿主 fiber 生命周期 —— 从插件里强行摘除
			// SessionStore 内部条目会绕过 owner 的收敛顺序，代价大于收益。
			//
			// 「客户端会话行」由**浏览器半**负责移除（它直接调客户端会话服务的
			// 官方 handleSessionRemoved，即服务端 api-session/removed 帧的同一条
			// 路径）。Host 这里只做磁盘与记账。
			try {
				const sessions = this.ctx.get("sessions");
				const live = sessions?.get?.(sessionId);
				if (live !== undefined) {
					try { await sessions.flush?.(live); removed.flushed = true; } catch { /* flush 失败不阻断删除 */ }
				}
			} catch (error) {
				removed.warnings.push(`live flush: ${errorMessage(error)}`);
			}

			// ── 5. 摘工作区记账（官方 detach 通道）───────────────────────────
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

			// ── 6. 删磁盘会话目录 ────────────────────────────────────────────
			const sessionsRoot = join(resolveHome(), ".dsh", "sessions");
			for (const dir of await candidateSessionDirs(sessionsRoot, cwd, sessionId)) {
				try {
					if (!existsSync(dir)) continue;
					await rm(dir, { recursive: true, force: true });
					removed.filesRemoved.push(dir);
				} catch (error) {
					removed.warnings.push(`rm ${dir}: ${errorMessage(error)}`);
				}
			}

			// ── 7. 清投影缓存 ────────────────────────────────────────────────
			await this.cleanProjectionCache(resolveHome(), sessionId, removed);

			return { ok: true, removed };
		}
		/** 校验 payload 并取出会话 id。 */
		requireSessionId(payload) {
			const id = String(payload?.sessionId ?? "");
			if (id === "") throw new Error("sessionId is required");
			return id;
		}
		/**
		 * 会话工件路径预览（preview 用）：日志目录与分片缓存。
		 * @param {object} registry - workspaceRegistry 服务。
		 * @param {string} sessionId - 会话 id。
		 */
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

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 解压**多帧** zstd 缓冲（DSH 的会话日志按落盘时机追加独立 zstd 帧）。
 * `zlib.zstdDecompressSync` 只解第一帧 —— 这曾导致把多帧日志误判为单行空壳。
 * 实现：按 zstd magic（0x28B52FFD）切帧，逐帧解压后拼接；单帧文件行为不变。
 *
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
 * DSH 数据根（`~/.dsh` 的上一级）。优先 `DSH_FORGET_SESSION_HOME`（测试隔离用），
 * 否则 OS 家目录。DSH 自身把会话/存储放在 `<home>/.dsh` 下（dsh-home-paths 约定）。
 * @returns {string} 家目录绝对路径。
 */
function resolveHome() {
	const override = process.env.DSH_FORGET_SESSION_HOME;
	if (override !== undefined && override !== "") return override;
	return homedir();
}

export { ForgetSessionGateway, ForgetSessionGateway as default };
