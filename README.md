# dsh-forget-session

DeepSeek Harness（DSH）插件：在会话行「…」菜单里加一个**「遗忘会话」**，
把该会话从侧栏与磁盘上彻底移除。灵枢记忆插件的沉淀数据不受影响。
桌面端与 Web 端通用（插件 UI 运行在两端同源的浏览器渲染层，行为一致）。

## 功能

仅在**会话行「…」菜单**新增一项：

- **「遗忘会话」**（order 500，排在官方「置顶 / 重命名 / 分支 / 归档」之后）
- 点击后**两段式确认**：该行变成「再次点击确认遗忘」，再点一次才执行
  （菜单内完成，不弹窗；失败信息直接显示在这一行上，不静默）
- 成功后该行消失，顶部 Toast 汇报删除摘要（删了几个工件、几条警告）

| 删除对象 | 方式 |
| --- | --- |
| 正在运行的工作 | 官方 `workspace/session-stop` 瀑布（stopActivity 归档路径） |
| 工作区记账（workspace.json 的 sessionIds） | 官方 `detachSession` 通道（domain 写链） |
| 归档集合 / 置顶集合 | 官方 `unarchiveSession` / `unpinSession` |
| 会话日志目录 `~/.dsh/sessions/<项目键>/<id>` | 整目录删除（含 `_no-cwd`、历史无前缀布局、占用重试） |
| 投影缓存分片 `~/.dsh/storages/session_projcache/sessions/<id>.json` | 删除 |
| 投影缓存总表 `~/.dsh/storages/session_projcache.json` 的表项 | 读-改-写，其余内容原样保留 |
| 复活文件（句柄残留 / 迟到写入重建） | Host「复活守卫」在 ~2 分钟窗口内自动再删 |
| 侧栏会话行（客户端会话列表） | 官方 `sessions.handleSessionRemoved(id)` + `sessions.refresh()` |

**不动的数据**：灵枢记忆（`~/.dsh/.dsh-memory`）、附件、其他任何会话。

## 修复了什么（为什么已删会话还会回到「未分组」）

「未分组」= 客户端会话列表里的 id − 所有 `workspace.sessionIds` 的并集。
对官方源码逐包取证后确认了两个复活路径：

| 根因 | 机制 | 对策 |
| --- | --- | --- |
| **Windows 活体删除竞态** | 会话打开过就有 write handle / 跨进程 lease：`rm` 目录报 EBUSY/EPERM，v1 静默失败 → 文件残留 → 重启后 registry 重新收编；且删除后活体 teardown 的迟到 append 会**重建已删目录** | 删除后**验证性复查**，占用类错误退避重试；布置**复活守卫**：2s 起指数退避（封顶 32s）、总窗 ~130s 周期复查，目录被重建立即再删 |
| **客户端列表复活** | Host 的 `session.list` 仍会列出活体会话；客户端任何一次 `refreshList`（重连即触发）都会把已删行合并回来 | 删除后调用官方 `sessions.refresh()` 重拉基线，让复活行在可见前被再次摘掉 |

> v2 一度还加过「会话体检 / 空壳清扫 / audit 盘点」等额外远端点，但它们并未
> 随客户端契约挂载，点了只会得到 `typert gateway` 错误，属于无用面 —— 已全部
> 移除，契约面只保留 `delete` 一个方法。

## 远端契约

`forgetSession` 服务只暴露一个方法：

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| `delete` | `{ sessionId }` | 全瀑布删除（权威状态 + 磁盘工件 + 复活守卫） |

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
  `ctx.remote.$mount` 只挂 `delete` 一个方法契约（strict codec 两键并写），
  `ctx.slots.inject("sidebar.workspaces.session.menu.item", ...)` 注册菜单行；
  Toast 走 `primitives.Toast`，经模块级 toast bus + `shell.overlay` 常驻组件
  渲染（**React hook 绝不能在 `apply()` 里调用** —— 渲染上下文之外没有
  dispatcher，会让整个 fiber FAILED）。
- **复活守卫**：`delete()` 成功后启动（无论本轮是否全清）；每档复查日志目录
  （cwd 已知按项目键定位，未知全扫）与分片缓存，删除再次成功会连带清分片。
  同一会话再次显式删除会重置守卫。

## 测试

```powershell
cd <本仓库目录>
node test/verify.mjs
```

隔离 HOME（`DSH_FORGET_SESSION_HOME` 指向临时目录），13 项断言覆盖：
契约面只含 `delete`、delete 全瀑布（目录/分片/总表项/detach）、正常会话零误伤、
幂等、缺参报错、复活守卫清除被重建目录。

> 测试需要 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-typert-protocol`
> （peer 依赖，随 DSH 提供），在装了本插件的 profile 内可直接运行。

## 已知边界

- DSH 官方设计是「会话只归档不删除」（见 dsh-client-ui-workspace README），
  本插件是官方通道之外的用户级补充；
- 若被删会话是本进程活体，Host 先 `flush` 落盘再删文件；活体摘除归它的宿主
  fiber 生命周期，守卫窗口（~130s）内 teardown 的迟到写入都会被补删。
  建议在空闲会话上使用删除；
- 会话搜索索引（`session-query-sqlite`）的 `openAt` 非 `never` 时，已删会话行
  会在下次 `_reconcile`（任何一次搜索）自动收敛 —— 持久化列表已不含该 id，
  索引走 `persistentDeletes` 清掉它；`openAt: never`（默认）为内存态，自愈。

## 许可

MIT
