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
 *  1. 删除成功后调用官方 `sessions.refresh()` 重拉会话基线 —— 若 Host 因活体
 *     仍列出该会话（refreshList 把行合并回来），重拉会在复活可见之前把它
 *     再次摘掉。（磁盘侧的复活由 Host 半的复活守卫独立处理，无需前端参与。）
 *  2. 菜单文案带删除摘要（删了几个工件、几条警告），结果以顶部 Toast 汇报。
 *
 * 契约面只挂 `delete` 一个方法：多余的方法会让 typert 网关整批拒绝
 * （表现为 `typert gateway: forgetSession/...` 错误），因此保持最小面。
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

		/** 文案（内置中文，不依赖宿主 locale 服务）。 */
		const TEXT = {
			menu: "遗忘会话",
			armed: "再次点击确认遗忘",
			busy: "正在遗忘…",
			failed: "遗忘失败：{message}",
			done: "已遗忘（工件 {files} 项{warn}）",
			doneWarn: "，{count} 条警告见控制台"
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
		 * 菜单行：两段式确认 + 就地反馈。
		 *
		 * 官方 `MenuItemButton` 的真实 props 是
		 * `{ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }`，
		 * 因此这里只用这套 props，不用 `title`/`label` 之类不存在的字段。
		 */
		function ForgetSessionMenuItem({ sessionId, useMenuOpenState, call, dropSession, refreshList, showToast }) {
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
					// 行移除：官方通道优先；随后重拉官方列表对齐（对抗 refreshList 复活）。
					if (typeof dropSession === "function") dropSession(sessionId);
					else removeSessionRow(sessionId);
					if (typeof refreshList === "function") refreshList();
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

		async function apply(ctx) {
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
			const DESCRIPTORS = [descriptorFor("delete")];

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
			const refreshList = () => refreshClientList(ctx);

			// 会话行「…」菜单：遗忘会话（唯一一项，契约面保持最小）。
			ctx.slots.inject(MENU_SLOT, () =>
				ctx.slots.register({
					name: MENU_SLOT,
					id: "forget",
					order: MENU_ORDER,
					inject: () => ({ call, dropSession, refreshList, showToast })
				}, ForgetSessionMenuItem)
			);

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
