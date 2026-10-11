# dsh-forget-session

DeepSeek Harness（DSH）插件：在每个会话的「…」菜单里加一个**「遗忘会话」**，
把该会话从侧栏与磁盘上彻底移除。灵枢记忆插件的沉淀数据不受影响。

![菜单示意](https://img.shields.io/badge/位置-会话行_%E2%80%A6_菜单-删除会话-blue)

## 功能

- 会话行「…」菜单新增**「遗忘会话」**（排在官方「归档会话」之后）；
- 点击后**两段式确认**：该行变成「再次点击确认遗忘」，再点一次才执行（菜单内完成，不弹窗；错误也直接显示在这一行上）；
- 确认后一键删除：

| 删除对象 | 方式 |
| --- | --- |
| 正在运行的工作 | 走官方 `workspace/session-stop` 瀑布（与「停止并归档」同一通道） |
| 工作区记账（workspace.json 的 sessionIds） | 官方 `detachSession` 通道（domain 写链） |
| 归档集合 / 置顶集合 | 官方 `unarchiveSession` / `unpinSession` |
| 会话日志目录 `~/.dsh/sessions/<项目键>/<session-<id>>` | 目录整体删除（含历史无前缀布局） |
| 投影缓存分片 `~/.dsh/storages/session_projcache/sessions/<id>.json` | 删除 |
| 投影缓存总表 `~/.dsh/storages/session_projcache.json` 的表项 | 读-改-写，其余内容原样保留 |
| 侧栏会话行（客户端会话列表） | 浏览器半调用官方 `sessions.handleSessionRemoved(id)`，等价于服务端 `api-session/removed` 帧 —— 行立即消失，且不会落进「未分组」 |

> 为什么必须动客户端会话列表：侧栏分组算法是
> `未分组 = 客户端会话列表里的 id − 所有 workspace.sessionIds 的并集`。
> 只摘 Host 记账而不清客户端列表，被删会话就会以「未分组」残影留在侧栏。

**不动的数据**：

- 灵枢记忆（`~/.dsh/.dsh-memory`）——记忆沉淀走 `session/event` 事件流，
  与会话日志文件完全无关；
- 附件 `~/.dsh/attachments`；
- 其他任何会话。

## 安装

本插件以 file: 依赖方式安装进 desktop profile（与 `dsh-skill-mcp-board` 同法）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "C:\Users\LENOVO\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs" install --ignore-scripts
```

`package.json` 中已声明：

```json
"dsh-forget-session": "file:D:/桌面/AI Port/DSH plugins/dsh-forget-session"
```

`dsh.profile.bundles` 数组里已加入 `"dsh-forget-session"`。

安装后**重启 DSH** 即生效。

## 卸载

1. `package.json` 的 `dependencies` 删除 `"dsh-forget-session"` 行，
   `dsh.profile.bundles` 删除 `"dsh-forget-session"` 项；
2. 重跑上面的 `pnpm install`；
3. 重启 DSH。

## 工作原理（给维护者）

- **Host 半**（`lib/index.js`）：`TypertRemoteService`，服务名
  `sessionDelete`，`inject: ["workspaceRegistry"]`。`delete()` 先走官方
  状态通道（stop / unarchive / unpin / detach），再按
  `session-persistence-jsonl` 的同构路径算法（`projectKey` + `encodeSegment`）
  删除磁盘工件，最后清投影缓存。全程不手改 `workspace.json` —— 记账由
  registry 的官方 mutate 写链完成。
- **浏览器半**（`lib/client.js`）：模块加载器包（`window.__ModuleLoader__`），
  `ctx.remote.$mount` 挂载契约（与官方 descriptor 同构，strict codec 两键并写），
  `ctx.slots.inject("sidebar.workspaces.session.menu.item", ...)` 注册菜单行
  （order 500，官方占位 100–400 之后），确认框挂在 `shell.overlay`。
  视觉全部复用 `@deepseek-ai/dsh-client-ui-primitives`（MenuItemButton /
  Modal / Button / IconTrashOutlineRegular），随主题。
- **活体说明**：若被删会话正在本进程存活（Session store 活体），Host 会先
  `flush` 落盘再删文件；活体摘除归它的宿主 fiber 生命周期，进程退出即收敛。
  建议在空闲会话上使用删除。

## 已知边界

- DSH 官方设计是「会话只归档不删除」（见 dsh-client-ui-workspace README），
  本插件是官方通道之外的用户级补充；
- 被删除会话若产生过 `dsh-session-archive/archive-ledger.json` 记录，账本为空
  映射结构，无残留条目需要清理（v1 账本为 `{"version":1,"entries":{}}`）；
- 会话搜索索引（`session-query-sqlite`）默认 `openAt: never`（内存态），
  进程生命周期内自愈，无磁盘残留。

## 测试隔离

Host 半的 home 解析支持 `DSH_FORGET_SESSION_HOME` 环境变量覆盖（仅供自动化
测试把 `.dsh` 指到临时目录）；正常使用无需设置。

## 许可

MIT
