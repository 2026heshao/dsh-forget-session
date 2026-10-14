# dsh-forget-session

DeepSeek Harness（DSH）插件：在每个会话的「…」菜单里加一个**「遗忘会话」**，
把该会话从侧栏与磁盘上彻底移除；再加一个**「会话体检」**一键清扫空壳幽灵。
灵枢记忆插件的沉淀数据不受影响。
桌面端与 Web 端通用（插件 UI 运行在两端同源的浏览器渲染层，行为一致）。

## v2 修复了什么（为什么已删会话还会回到「未分组」）

对官方源码逐包取证后确认了三个根因，v2 全部处理：

| 根因 | 机制 | v2 对策 |
| --- | --- | --- |
| **空壳清扫从未生效** | v1 `sweepShells` 用了 `zlib.zstdDecompressSync` 却**没有 import `zlib`** → 对 zstd 日志恒抛 `ReferenceError` 且被 catch 吞掉 → 空壳永远清不掉，重启后 registry 重新收编进「未分组」 | 显式 `import * as zlib`；世代文件按版本号取最新（v0 `session.jsonl` 与 vN `session.v4.jsonl` 多世代不再误判） |
| **Windows 活体删除竞态** | 会话打开过就有 write handle / 跨进程 lease：`rm` 目录报 EBUSY/EPERM，v1 静默失败 → 文件残留 → 重启后重新收编；且删除后活体 teardown 的迟到 append 会**重建已删目录** | 删除后**验证性复查**（`existsSync`），占用类错误退避重试 ×3；并布置**复活守卫**：2s 起指数退避（封顶 32s）、总窗 ~130s 的周期复查，目录被重建立即再删 |
| **客户端列表复活** | Host 的 `session.list` 会列出活体会话；客户端任何一次 `refreshList`（重连即触发）都会把已删的行 `mergeSummary` 合并回来 | 浏览器半在删除后 +4s / +20s 调 Host `verify(apply:true)` 补删复活文件，每次复查后调用官方 `sessions.refresh()` 重拉基线，复活行在可见前被再次摘掉 |

## 功能

- 会话行「…」菜单新增**「遗忘会话」**（order 500，排在官方四项之后）：
  两段式确认（第一次点变成「再次点击确认遗忘」），菜单内完成，不弹窗；
  错误直接显示在这一行上。
- 同一菜单再挂**「会话体检」**（order 600，全局动作）：调用 Host
  `audit`（只读盘点全部磁盘会话目录的记账/活体/空壳状态）+ 
  `sweepShells(apply:true)`（清扫空壳），顶部 Toast 汇报
  「未记账磁盘会话 N 个，清扫空壳 M 个」——一键清掉幽灵的磁盘来源。
- 删除动作一键完成：

| 删除对象 | 方式 |
| --- | --- |
| 正在运行的工作 | 官方 `workspace/session-stop` 瀑布（stopActivity 归档路径） |
| 工作区记账（workspace.json 的 sessionIds） | 官方 `detachSession` 通道（domain 写链） |
| 归档集合 / 置顶集合 | 官方 `unarchiveSession` / `unpinSession` |
| 会话日志目录 `~/.dsh/sessions/<项目键>/<id>` | 整目录删除（含 `_no-cwd`、历史无前缀布局、占用重试） |
| 投影缓存分片 `~/.dsh/storages/session_projcache/sessions/<id>.json` | 删除 |
| 投影缓存总表 `~/.dsh/storages/session_projcache.json` 的表项 | 读-改-写，其余内容原样保留 |
| 复活文件（EBUSY 残留 / 迟到 append 重建） | Host 复活守卫 + 客户端 verify 复查，~2 分钟窗口内自动再删 |
| 侧栏会话行（客户端会话列表） | 浏览器半调用官方 `sessions.handleSessionRemoved(id)` + `sessions.refresh()` |

**不动的数据**：灵枢记忆（`~/.dsh/.dsh-memory`）、附件、其他任何会话。

## Host 远端方法（契约 `forgetSession`）

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| `delete` | `{ sessionId }` | 全瀑布删除 + 布置复活守卫 |
| `verify` | `{ sessionId, apply? }` | 复查工件是否复活；`apply:true` 补删 |
| `sweepShells` | `{ apply? }` | 扫描/清扫空壳（全部帧都是 header 的会话目录） |
| `audit` | `{}` | 只读盘点：每个磁盘会话目录的记账/归档/活体/空壳状态 |
| `preview` | `{ sessionId }` | 预览将删除的路径，不写任何东西 |

## 安装

用 DSH 官方命令安装（装进哪个 profile，就在哪个端生效）：

```sh
dsh plugin --profile web add github:2026heshao/dsh-forget-session
```

装完**重启 DSH** 即生效（`--profile` 后换成你实际使用的 profile 名）。

## 卸载

```sh
dsh plugin --profile web remove dsh-forget-session
```

`remove` 会同时移除依赖与补丁层，重启 DSH 后菜单恢复原状。

## 工作原理（给维护者）

- **Host 半**（`lib/index.js`）：`TypertRemoteService`，服务名 `forgetSession`，
  `inject: ["workspaceRegistry"]`。`delete()` 走官方状态通道
  （stop / unarchive / unpin / detach），再按 `session-persistence-jsonl` 的
  同构路径算法（`projectKey` + `encodeSegment`）删除磁盘工件（占用类错误
  退避重试 + 验证性复查），清投影缓存，最后布置复活守卫。全程不手改
  `workspace.json` —— 记账由 registry 的官方 mutate 写链完成。
- **浏览器半**（`lib/client.js`）：`window.__ModuleLoader__` 包，
  `ctx.remote.$mount` 挂载 5 个方法契约（strict codec 两键并写），
  `ctx.slots.inject("sidebar.workspaces.session.menu.item", ...)` 注册菜单行
  （官方占位 100–400 之后），Toast 走 `primitives.Toast` 挂在
  `shell.overlay`。视觉全部复用 `@deepseek-ai/dsh-client-ui-primitives`
  （MenuItemButton / Toast / IconTrashOutlineRegular / IconChecklistOutlineRegular）。
- **复活守卫细节**：`delete()` 成功后启动（无论本轮是否全清）；每档复查
  日志目录（cwd 已知按项目键定位，未知全扫）与分片缓存；删除再次成功会
  连带清分片。同一会话再次显式删除会重置守卫；`sweepShells` 清掉的空壳
  会停掉其守卫。
- **活体说明**：若被删会话是本进程活体，Host 先 `flush` 落盘再删文件；
  活体摘除归它的宿主 fiber 生命周期。守卫窗口（~130s）内 teardown 的
  迟到写入都会被补删。建议在空闲会话上使用删除。

## 测试

```powershell
cd "D:\桌面\AI Port\DSH plugins\dsh-forget-session"
node test/verify.mjs
```

隔离 HOME（`DSH_FORGET_SESSION_HOME` 指向临时目录），25 项断言覆盖：
空壳识别（zstd 多帧 / 明文 v0 / 无前缀 id / `_no-cwd`）、正常会话零误伤、
dry-run 不删、apply 清扫、audit 盘点、preview、delete 全瀑布（目录/分片/
总表项/detach）、verify 复查补删、幂等、复活守卫重建清除。

## 已知边界

- DSH 官方设计是「会话只归档不删除」（见 dsh-client-ui-workspace README），
  本插件是官方通道之外的用户级补充；
- 被删除会话若产生过 `dsh-session-archive/archive-ledger.json` 记录，账本
  为空映射结构，无残留条目需要清理；
- 会话搜索索引（`session-query-sqlite`）的 `openAt` 配置为非 `never` 时，
  索引内的已删会话行会在下次 `_reconcile`（任何一次搜索）时自动收敛消失
  —— 持久化列表已不含该 id，索引会以 `persistentDeletes` 路径清掉它；
  `openAt: never`（默认）则索引为内存态，进程生命周期内自愈。

## 许可

MIT
