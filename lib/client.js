/**
 * dsh-forget-session — 浏览器半。
 *
 * 在会话行「…」菜单（`sidebar.workspaces.session.menu.item`）挂一行「遗忘会话」，
 * 采用**两段式确认**：第一次点击把该行变成「再次点击确认遗忘」，第二次点击才真正执行。
 *
 * 为什么不用弹窗：弹窗要依赖 shell.overlay 注册 + 共享状态 + 自定义 hook 三处，
 * 任何一处没接上都会表现为「点了没反应」。两段式确认全部状态都在菜单项组件内部，
 * 组件能渲染（用户看得见这一行）就一定能工作；失败信息也直接显示在这一行上，
 * 不再静默。
 */
window.__ModuleLoader__.load({
	id: "dsh-forget-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { useState } = React;

		const PLUGIN_ID = "dsh-forget-session";
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		const MENU_ORDER = 500;

		/** 文案（内置中文，不依赖宿主 locale 服务）。 */
		const TEXT = {
			menu: "遗忘会话",
			armed: "再次点击确认遗忘",
			busy: "正在遗忘…",
			failed: "遗忘失败：{message}"
		};
		const format = (key, params) => {
			let text = TEXT[key] ?? key;
			if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
			return text;
		};

		/**
		 * 让客户端把该会话从**会话列表**里移除。
		 *
		 * 为什么必须做这件事：侧栏分组的官方算法是
		 *
		 *   accounted = 所有 workspace.sessionIds 的并集
		 *   未分组    = 客户端会话列表里的 id − accounted
		 *
		 * （见 @deepseek-ai/dsh-client-ui-workspace 的 ClientWorkspaceModel）
		 * 只摘 Host 端记账、不清客户端列表，被删会话就会落进「未分组」残影。
		 *
		 * 官方移除路径是服务端 `api-session/removed` 帧 → 客户端
		 * `sessions.handleSessionRemoved(id)`（见 dsh-api-session-controller 的
		 * 客户端 apply：`ctx.remote.$on("api-session/removed", …)`）。
		 * 这里直接调用**同一个官方方法**，等价于服务端补发了那一帧。
		 *
		 * @param ctx - 浏览器半的 Cordis 上下文。
		 * @param sessionId - 目标会话 id。
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

		/**
		 * 菜单行：两段式确认 + 就地反馈。
		 *
		 * 官方 `MenuItemButton` 的真实 props 是
		 * `{ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }`
		 * （见 @deepseek-ai/dsh-client-ui-primitives 的 lib/index.js），
		 * 因此这里只用这套 props，不用 `title`/`label` 之类不存在的字段。
		 *
		 * @param props.sessionId - 目标会话 id（slot 传入）。
		 * @param props.useMenuOpenState - slot 注入的菜单开合 hook（缺失则退化）。
		 * @param props.call - 本插件 inject 注入的 Host 调用器。
		 * @param props.dropSession - 本插件 inject 注入的客户端行移除器。
		 */
		function ForgetSessionMenuItem({ sessionId, useMenuOpenState, call, dropSession }) {
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
					// Host 端的非致命警告透传到控制台，便于出问题时定位
					// （不弹到界面上：多数警告是「会话本就不在」这类幂等情形）。
					const warnings = result?.removed?.warnings;
					if (Array.isArray(warnings) && warnings.length > 0) {
						console.warn(`[${PLUGIN_ID}] host warnings for ${sessionId}:`, warnings);
					}
					// 优先走官方移除（更新客户端会话列表状态，React 随之重渲染）；
					// 注入缺失时才退回 DOM 兜底。
					if (typeof dropSession === "function") dropSession(sessionId);
					else removeSessionRow(sessionId);
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
			// ── Host 契约挂载（与可用插件 dsh-skill-mcp-board 的 descriptor 同构）──
			const ANY_VALUE_SCHEMA = { parse: (v) => v };
			const strictCodec = (symbol) => ({
				mode: "strict",
				typeSymbol: `${PLUGIN_ID}/typert#${symbol}`,
				schema: ANY_VALUE_SCHEMA,
				create: () => ANY_VALUE_SCHEMA
			});
			const DESCRIPTORS = [{
				id: `${PLUGIN_ID}#forgetSession/delete`,
				service: "forgetSession",
				namespace: "forgetSession",
				method: "delete",
				invocation: { kind: "direct" },
				parameters: [{ name: "payload", wire: "payload", source: "json", codec: strictCodec("AnyValue") }],
				result: strictCodec("DeleteResult"),
				sourceLocation: { file: `${PLUGIN_ID}/lib/index.js`, line: 1, column: 1 }
			}];

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

			/**
			 * 客户端行移除器：优先官方会话服务，失败返回 false（调用方退回 DOM 兜底）。
			 * 用闭包直接捕获 ctx，省掉一层 inject 传递。
			 *
			 * @param sessionId - 目标会话 id。
			 * @returns {boolean} 是否成功走了官方通道。
			 */
			const dropSession = (sessionId) => releaseSessionRow(ctx, sessionId);

			ctx.slots.inject(MENU_SLOT, () =>
				ctx.slots.register({
					name: MENU_SLOT,
					id: "forget",
					order: MENU_ORDER,
					inject: () => ({ call, dropSession })
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
