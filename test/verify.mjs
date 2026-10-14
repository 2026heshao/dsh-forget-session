/**
 * dsh-forget-session v2 全量验证（隔离 HOME，不碰真实 ~/.dsh）。
 * 覆盖：sweepShells 修复（zstd 多帧 + 明文 + 多世代）、delete 全瀑布、
 * verify 复查补删、audit 盘点、复活守卫、幂等性、正常会话零误伤。
 */
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const mod = await import("../lib/index.js");
const home = mkdtempSync(join(tmpdir(), "fs-v2-"));
process.env.DSH_FORGET_SESSION_HOME = home;

const root = join(home, ".dsh", "sessions");
const projDir = join(root, "--D-proj--");
mkdirSync(projDir, { recursive: true });

// ── 夹具 ──────────────────────────────────────────────────────────────
// 1) 空壳 A（zstd 多帧：header 帧 ×2，触发 v1 的 ReferenceError 路径）
const shellA = join(projDir, "session-shellA");
mkdirSync(shellA);
writeFileSync(join(shellA, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(
	Buffer.from(JSON.stringify({ type: "session", version: 4, id: "session-shellA", createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n", "utf8")
));
writeFileSync(join(shellA, "session.v4.jsonl.zstd"), Buffer.concat([
	zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", version: 4, id: "session-shellA", createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n", "utf8")),
	zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", version: 4, id: "session-shellA", createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n", "utf8"))
]));

// 2) 空壳 B（明文 v0 世代文件 session.jsonl，无前缀 id，_no-cwd 项目）
const noCwd = join(root, "_no-cwd");
const shellB = join(noCwd, "2e04d66-3cfb-42a6-bfaf-1bbc134eb4c7");
mkdirSync(shellB, { recursive: true });
writeFileSync(join(shellB, "session.jsonl"), JSON.stringify({ type: "session", version: 4, id: "2e04d66-3cfb-42a6-bfaf-1bbc134eb4c7", createdAt: 1, isSeeded: false, delegationDepth: 0 }) + "\n");

// 3) 正常会话（header + 用户事件，明文 v4）
const realDir = join(projDir, "session-real");
mkdirSync(realDir);
writeFileSync(join(realDir, "session.v4.jsonl"), JSON.stringify({ type: "session", version: 4, id: "session-real", createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n");

// 4) 待删除目标（含 projcache 分片 + 总表项 + 会话目录）
const victimId = "session-victim";
const victimDir = join(projDir, victimId);
mkdirSync(victimDir);
writeFileSync(join(victimDir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(
	Buffer.from(JSON.stringify({ type: "session", version: 4, id: victimId, createdAt: 2, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n", "utf8")
));
mkdirSync(join(home, ".dsh", "storages", "session_projcache", "sessions"), { recursive: true });
writeFileSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`), "{}");
writeFileSync(join(home, ".dsh", "storages", "session_projcache.json"), JSON.stringify({
	unit: { name: "session_projcache", version: 3 }, global: null,
	tables: { sessions: { [victimId]: { keep: true }, "session-other": { keep: true } } }
}, null, 1));

// ── 假 registry / ctx ────────────────────────────────────────────────
const detached = [];
const registry = {
	readSessionHeader: async (id) => ({ id, cwd: id === victimId ? "D:\\proj" : undefined }),
	archiveSession: async () => {}, unarchiveSession: async () => {}, unpinSession: async () => {},
	list: () => [{ sessionIds: [victimId, "session-real"], detachSession: async (id) => detached.push(id) }],
	archivedSessionIds: [], pinnedSessionIds: []
};
// 真 Cordis Context：Service 构造器需要 ctx.reflect.provide。
const { Context } = await import("@deepseek-ai/cordis");
const baseCtx = new Context();
const ctx = baseCtx.extend({
	workspaceRegistry: registry,
	get(key) { return key === "workspaceRegistry" ? registry : undefined; }
});
const gateway = new mod.default(ctx, undefined);

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// 1) sweepShells dry-run：两个空壳都被识别（v1 在这里抛错被吞 → 0 个）
const scan = await gateway.sweepShells({});
check("sweep.scan.ok", scan.ok === true);
check("sweep.scan.findsZstdShell", scan.shells.some((s) => s.sessionId === "session-shellA"));
check("sweep.scan.findsPlaintextNoCwdShell", scan.shells.some((s) => s.sessionId?.startsWith("2e04d66")));
check("sweep.scan.skipsRealSession", !scan.shells.some((s) => s.sessionId === "session-real"));
check("sweep.dryRun.noDelete", existsSync(shellA) && existsSync(shellB));

// 2) sweepShells apply
const swept = await gateway.sweepShells({ apply: true });
check("sweep.apply.swept2", swept.swept === 2);
check("sweep.apply.shellAGone", !existsSync(shellA));
check("sweep.apply.shellBGone", !existsSync(shellB));
check("sweep.apply.realIntact", existsSync(realDir));

// 3) audit：real 在记账里（假 registry 记了 victim/real）→ unaccounted 只剩 real 外的
//    这里 shell 已清，victim 未删 → unaccountedCount 应为 0（victim+real 都在假记账里）
const audit1 = await gateway.audit();
check("audit.ok", audit1.ok === true);
check("audit.counts", audit1.sessions.length === 2);
check("audit.unaccounted0", audit1.unaccountedCount === 0);

// 4) preview
const preview = await gateway.preview({ sessionId: victimId });
check("preview.ok", preview.ok === true);
check("preview.namesLogDir", (preview.logDirs ?? []).some((d) => d === victimDir));

// 5) delete：目录 + 分片 + 总表项都清；记账 detach 调到 victim
const del = await gateway.delete({ sessionId: victimId });
check("delete.ok", del.ok === true);
check("delete.dirGone", !existsSync(victimDir));
check("delete.shardGone", !existsSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`)));
const projcacheAfter = JSON.parse(await import("node:fs").then((m) => m.readFileSync(join(home, ".dsh", "storages", "session_projcache.json"), "utf8")));
check("delete.tableEntryGone", projcacheAfter.tables.sessions[victimId] === undefined);
check("delete.tableOtherKept", projcacheAfter.tables.sessions["session-other"] !== undefined);
check("delete.detachCalled", detached.includes(victimId));
check("delete.guardScheduled", del.removed?.guardScheduled === true);

// 6) verify：目录已消失 → dirExists=false；再手动复活一个目录，apply:true 应补删
const v1 = await gateway.verify({ sessionId: victimId });
check("verify.clean", v1.ok === true && v1.dirExists === false);
mkdirSync(victimDir, { recursive: true }); // 模拟活体 teardown 复活
writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
const v2 = await gateway.verify({ sessionId: victimId, apply: true });
check("verify.resweep", v2.reswept === 1 && !existsSync(victimDir));

// 7) 幂等：再删一次不抛错
const del2 = await gateway.delete({ sessionId: victimId });
check("delete.idempotent", del2.ok === true);

// 8) 复活守卫：等待守卫跑完（总窗 ~130s 太长 → 只验证守卫在跑：删掉后立刻重建，守卫应清掉）
mkdirSync(victimDir, { recursive: true });
writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
await new Promise((r) => setTimeout(r, 4000)); // 守卫第一档 2s 后会清
check("guard.resurrectedRemoved", !existsSync(victimDir));
gateway.stopGuard(victimId);

// 清理
rmSync(home, { recursive: true, force: true });
const pass = results.every(([, ok]) => ok);
console.log(pass ? "\nFINAL: ALL PASSED" : `\nFINAL: FAILED (${results.filter(([, ok]) => !ok).length} failures)`);
process.exit(pass ? 0 : 1);
