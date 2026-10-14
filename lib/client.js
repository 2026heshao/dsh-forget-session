/**
 * dsh-forget-session — 浏览器半 v2。
 *
 * 在会话行「…」菜单（`sidebar.workspaces.session.menu.item`）挂一行「遗忘会话」，
 * 采用**两段式确认**：第一次点击把该行变成「再次点击确认遗忘」，第二次点击才
 * 真正执行。全部状态都在菜单项组件内部，组件能渲染就一定能工作；错误直接显示
 * 在这一行上，不静默。
 *
 * v2 升级（配合 Host 半 v2）：
 *
 *  1. 删除成功后 +4s / +20s 各调一次 Host `verify(apply:true)` 复查并补删
 *     复活文件（EBUSY 残留 / 活体 teardown 迟到 append 重建）。
 *  2. 每次复查后调用官方 `sessions.refresh()` 重拉会话基线 —— 若 Host 因活体
 *     仍列出该会话（refreshList 把行合并回来），复查补删 + 列表重拉会在
 *     复活可见之前把它再次摘掉。
 *  3. 新增「会话体检」菜单（挂在工作区分组头菜单上同样两段式确认）：调用
 *     Host `audit`（只读）+ `sweepShells(apply:true)`（清扫空壳），结果以
 *     顶部 Toast 汇报 —— 一键清掉所有「未分组」幽灵的磁盘来源。
 *  4. 菜单文案带删除摘要（删了几个工件、几条警告）。
 */
window.__ModuleLoader__.load({
	id: "dsh-forget-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { useState, useEffect } = React;

		const PLUGIN_ID = "dsh-forget-session";
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		const MENU_ORDER = 500;
		// 工作区分组头菜单是官方硬编码的数据驱动 Menu（rename/delete），没有
		// slot 可挂；体检是全局动作，挂在会话菜单的第二位（order 600）最稳。
		const MAINTENANCE_MENU_ORDER = 600;
		/** 删除后的复查时刻（ms）。覆盖活体 handle 释放与 teardown 迟到写入。 */
		const VERIFY_DELAYS_MS = [4_000, 20_000];

		/** 文案（内置中文，不依赖宿主 locale 服务）。 */
		const TEXT = {
			menu: "遗忘会话",
			armed: "再次点击确认遗忘",
			busy: "正在遗忘…",
			failed: "遗忘失败：{message}",
			done: "已遗忘（工件 {files} 项{warn}）",
			doneWarn: "，{count} 条警告见控制台",
			maintenance: "会话体检（清扫空壳）",
			maintenanceArmed: "再次点击确认体检清扫",
			maintenanceBusy: "正在体检…",
			maintenanceFailed: "体检失败：{message}",
			maintenanceDone: "体检完成：未记账磁盘会话 {stray} 个，清扫空壳 {swept} 个"
		};
		const format = (key, params) => {
			let text = TEXT[key] ?? key;
			if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
			return text;
		};

		/** 应用内 Toast 总线：apply 期只发射（showToast），React hook 全部留在组件里。 */
		/** hook 绝不能在 apply（React 渲染上下文之外）调用 —— useState 会因 dispatcher 为 null 抛错，整个 fiber 直接 FAILED。 */
		const toastBus = { listener: null, seq: 0 };
		const showToast = (text, tone) => {
			const item = { seq: ++toastBus.seq, text, tone };
			try {
				if (toastBus.listener) toastBus.listener(item);
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] toast dispatch failed:`, error);
			}
		};

		/** shell.overlay 常驻组件：订阅 toastBus 渲染顶部 Toast（注册方式同 dsh-market/workbuddy-update）。 */
		function ForgetSessionToaster() {
			const [toast, setToast] = useState(null);
			useEffect(() => {
				toastBus.listener = setToast;
				return () => {
					toastBus.listener = null;
				};
			}, []);
			if (toast === null) return null;
			return jsxRuntime.jsx(primitives.Toast, {
				text: toast.text,
				tone: toast.tone,
				holdMs: 6_000,
				onDone: () => {
					setToast((current) => (current !== null && current.seq === toast.seq ? null : current));
				}
			});
		}

		/**
		 * 让客户端把该会话从**会话列表**里移除。
		 *
		 * 侧栏分组的官方算法：
		 *
		 *   accounted = 所有 workspace.sessionIds 的并集
		 *   未分组    = 客户端会话列表里的 id − accounted
		 *
		 * 只摘 Host 端记账、不清客户端列表，被删会话就会落进「未分组」残影。
		 * 官方移除路径是服务端 `api-session/removed` 帧 → 客户端
		 * `sessions.handleSessionRemoved(id)`。这里直接调用**同一个官方方法**。
		 *
		 * @returns {boolean} 是否走了官方通道（false 表示只能退回 DOM 兜底）。
		 */
		function releaseSessionRow(ctx, sessionId) {
			try {
				const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
				if (sessions && typeof sessions.handleSessionRemoved === "function") {
					sessions.handleSessionRemoved(sessionId);
					return true;
				}
				console.warn(`[${PLUGIN_ID}] client sessions service unavailable; falling back to DOM removal`);
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] official row removal failed:`, error);
			}
			return false;
		}

		/** DOM 兜底：官方通道不可用时至少把行从页面上摘掉。 */
		function removeSessionRow(sessionId) {
			try {
				const selector = `[data-row-key="session:${CSS.escape(sessionId)}"]`;
				for (const node of document.querySelectorAll(selector)) node.remove();
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] row removal skipped:`, error);
			}
		}

		/** 官方列表重拉（对抗 refreshList 复活）；失败只记控制台。 */
		function refreshClientList(ctx) {
			try {
				const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
				if (sessions && typeof sessions.refresh === "function") {
					Promise.resolve(sessions.refresh()).catch((error) => {
						console.warn(`[${PLUGIN_ID}] list refresh failed:`, error);
					});
				}
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] list refresh skipped:`, error);
			}
		}

		/**
		 * 删除后的复活复查：+4s / +20s 调 Host verify(apply:true) 补删复活文件，
		 * 每次复查后重拉官方列表。任何一次发现目录被重建都会在控制台留痕。
		 */
		function scheduleVerify(ctx, call, sessionId) {
			for (const delay of VERIFY_DELAYS_MS) {
				setTimeout(() => {
					Promise.resolve(call("verify", { sessionId, apply: true })).then((result) => {
						if (!result || result.ok === false) return;
						if (result.dirExists === true || (Array.isArray(result.existingDirs) && result.existingDirs.length > 0)) {
							console.warn(`[${PLUGIN_ID}] session ${sessionId} artifacts resurrected; re-swept:`, result);
						}
						refreshClientList(ctx);
					}).catch((error) => {
						console.warn(`[${PLUGIN_ID}] verify failed for ${sessionId}:`, error);
					});
				}, delay);
			}
		}

		/**
		 * 菜单行：两段式确认 + 就地反馈。
		 *
		 * 官方 `MenuItemButton` 的真实 props 是
		 * `{ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }`，
		 * 因此这里只用这套 props，不用 `title`/`label` 之类不存在的字段。
		 */
		function ForgetSessionMenuItem({ sessionId, useMenuOpenState, call, dropSession, showToast }) {
			const [phase, setPhase] = useState("idle");
			const [error, setError] = useState(null);
			// slot 级 hook：正常一定存在；缺失时退化为 no-op，绝不因为取不到而抛错。
			const menuOpenState = typeof useMenuOpenState === "function" ? useMenuOpenState() : undefined;
			const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : () => {};

			const forget = () => {
				setPhase("busy");
				setError(null);
				Promise.resolve(call("delete", { sessionId })).then((result) => {
					if (result && result.ok === false) {
						setPhase("error");
						setError(result.error || "unknown error");
						return;
					}
					const removed = result?.removed;
					const warnings = removed?.warnings;
					if (Array.isArray(warnings) && warnings.length > 0) {
						console.warn(`[${PLUGIN_ID}] host warnings for ${sessionId}:`, warnings);
					}
					// 行移除：官方通道优先；随后复查窗口内由 verify + refresh 兜底。
					if (typeof dropSession === "function") dropSession(sessionId);
					else removeSessionRow(sessionId);
					refreshClientList(globalThis.__forgetSessionCtx ?? null);
					scheduleVerify(globalThis.__forgetSessionCtx ?? null, call, sessionId);
					if (typeof showToast === "function") {
						const warnNote = Array.isArray(warnings) && warnings.length > 0
							? format("doneWarn", { count: warnings.length })
							: "";
						showToast(format("done", { files: removed?.filesRemoved?.length ?? 0 }) + warnNote, warnings?.length > 0 ? undefined : "success");
					}
					setPhase("idle");
					setMenuOpen(false);
				}).catch((reason) => {
					setPhase("error");
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};

			const onSelect = () => {
				if (phase === "busy") return;
				if (phase === "idle") {
					// 第一段：进入待确认态，保持菜单打开，等第二次点击。
					setPhase("armed");
					setError(null);
					return;
				}
				// 第二段（armed / error）：真正执行。
				forget();
			};

			const label =
				phase === "busy" ? format("busy")
					: phase === "armed" ? format("armed")
						: phase === "error" ? format("failed", { message: error ?? "unknown" })
							: format("menu");

			return jsxRuntime.jsx(primitives.MenuItemButton, {
				icon: jsxRuntime.jsx(primitives.IconTrashOutlineRegular, {}),
				disabled: phase === "busy",
				danger: phase === "armed",
				onSelect,
				children: label
			});
		}

		/**
		 * 「会话体检」菜单行：audit（只读盘点）+ sweepShells(apply:true)（清扫
		 * 空壳），Toast 汇报。空壳是「未分组」幽灵的主要磁盘来源之一 —— 修复了
		 * v1 从未生效的清扫 bug 后，这里提供一键入口。
		 */
		function ForgetSessionMaintenanceItem({ useMenuOpenState, call, showToast }) {
			const [phase, setPhase] = useState("idle");
			const [error, setError] = useState(null);
			const menuOpenState = typeof useMenuOpenState === "function" ? useMenuOpenState() : undefined;
			const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : () => {};

			const run = () => {
				setPhase("busy");
				setError(null);
				Promise.resolve(call("audit", {})).then((auditResult) => {
					const stray = auditResult?.ok === true ? Number(auditResult.unaccountedCount ?? 0) : -1;
					return Promise.resolve(call("sweepShells", { apply: true })).then((sweepResult) => {
						if (sweepResult && sweepResult.ok === false) throw new Error(sweepResult.error || "sweep failed");
						const errors = Number(sweepResult?.errors ?? 0);
						if (errors > 0) console.warn(`[${PLUGIN_ID}] sweep reported ${errors} unreadable session dirs`);
						if (typeof showToast === "function") {
							showToast(format("maintenanceDone", { stray, swept: Number(sweepResult?.swept ?? 0) }), "success");
						}
						setPhase("idle");
						setMenuOpen(false);
					});
				}).catch((reason) => {
					const message = reason instanceof Error ? reason.message : String(reason);
					setPhase("error");
					setError(message);
					console.warn(`[${PLUGIN_ID}] maintenance failed:`, reason);
				});
			};

			const onSelect = () => {
				if (phase === "busy") return;
				if (phase === "idle") {
					setPhase("armed");
					setError(null);
					return;
				}
				run();
			};

			const label =
				phase === "busy" ? format("maintenanceBusy")
					: phase === "armed" ? format("maintenanceArmed")
						: phase === "error" ? format("maintenanceFailed", { message: error ?? "unknown" })
							: format("maintenance");

			return jsxRuntime.jsx(primitives.MenuItemButton, {
				icon: jsxRuntime.jsx(primitives.IconChecklistOutlineRegular, {}),
				disabled: phase === "busy",
				onSelect,
				children: label
			});
		}

		async function apply(ctx) {
			// 供菜单闭包在 ctx 不可直传时使用（组件 props 已直传，此为兜底）。
			globalThis.__forgetSessionCtx = ctx;

			// ── Host 契约挂载（与官方 descriptor 同构，strict codec 两键并写）──
			const ANY_VALUE_SCHEMA = { parse: (v) => v };
			const strictCodec = (symbol) => ({
				mode: "strict",
				typeSymbol: `${PLUGIN_ID}/typert#${symbol}`,
				schema: ANY_VALUE_SCHEMA,
				create: () => ANY_VALUE_SCHEMA
			});
			const descriptorFor = (method) => ({
				id: `${PLUGIN_ID}#forgetSession/${method}`,
				service: "forgetSession",
				namespace: "forgetSession",
				method,
				invocation: { kind: "direct" },
				parameters: [{ name: "payload", wire: "payload", source: "json", codec: strictCodec("AnyValue") }],
				result: strictCodec("AnyResult"),
				sourceLocation: { file: `${PLUGIN_ID}/lib/index.js`, line: 1, column: 1 }
			});
			const DESCRIPTORS = ["delete", "verify", "sweepShells", "audit", "preview"].map(descriptorFor);

			const disposeMount = await ctx.remote.$mount({ package: PLUGIN_ID, descriptors: DESCRIPTORS });

			/**
			 * 调用 Host：返回统一信封 `{ ok, ...value }` / `{ ok:false, error }`，
			 * 任何异常都转成可显示的 error（绝不静默）。
			 */
			const call = async (method, args) => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("remote.forgetSession") : null;
					if (!service || typeof service[method] !== "function") {
						return { ok: false, error: "Host 服务未连接（restart DSH）" };
					}
					const reply = await service[method](args);
					if (reply && reply.ok === true) {
						return { ok: true, ...((reply.value && typeof reply.value === "object") ? reply.value : {}) };
					}
					const detail = reply?.error;
					return { ok: false, error: (detail && (detail.message || detail.code)) || "Host 调用失败" };
				} catch (reason) {
					return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
				}
			};

			// 应用内 Toast：shell.overlay 常驻组件（同 dsh-market/workbuddy-update 注册方式）。
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "forget-session-toast" }, ForgetSessionToaster)
			);

			const dropSession = (sessionId) => releaseSessionRow(ctx, sessionId);

			// 会话行「…」菜单：遗忘会话（order 500）+ 会话体检（order 600，全局动作）。
			ctx.slots.inject(MENU_SLOT, function* () {
				yield ctx.slots.register({
					name: MENU_SLOT,
					id: "forget",
					order: MENU_ORDER,
					inject: () => ({ call, dropSession, showToast })
				}, ForgetSessionMenuItem);
				yield ctx.slots.register({
					name: MENU_SLOT,
					id: "forget-maintenance",
					order: MAINTENANCE_MENU_ORDER,
					inject: () => ({ call, showToast })
				}, ForgetSessionMaintenanceItem);
			});

			return async function cleanup() {
				try { await disposeMount?.(); } catch { /* 已卸载 */ }
			};
		}

		const inject = ["slots", "remote", "typert"];

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
