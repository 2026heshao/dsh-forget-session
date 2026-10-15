/**
 * dsh-forget-session v2.1 验证（隔离 HOME，不碰真实 ~/.dsh）。
 *
 * 契约面只剩 `delete` 一个远端方法（体检/清扫等额外方法已按要求移除）。
 * 覆盖：delete 全瀑布（目录/分片/总表项/detach）、幂等、复活守卫（被重建的
 * 目录会被自动再删）、正常会话零误伤、缺参报错。
 */
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const mod = await import("../lib/index.js");
const home = mkdtempSync(join(tmpdir(), "fs-v21-"));
process.env.DSH_FORGET_SESSION_HOME = home;

const root = join(home, ".dsh", "sessions");
const projDir = join(root, "--D-proj--");
mkdirSync(projDir, { recursive: true });

// ── 夹具 ──────────────────────────────────────────────────────────────
const victimId = "session-victim";
const victimDir = join(projDir, victimId);
const header = JSON.stringify({ type: "session", version: 4, id: victimId, createdAt: 2, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 });
mkdirSync(victimDir);
writeFileSync(join(victimDir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(
	Buffer.from(header + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n", "utf8")
));

// 旁证：一个正常会话（绝不能被误删）
const otherId = "session-other";
const otherDir = join(projDir, otherId);
mkdirSync(otherDir);
writeFileSync(join(otherDir, "session.v4.jsonl"), JSON.stringify({ type: "session", version: 4, id: otherId, createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n");

// 投影缓存：分片 + 总表项
mkdirSync(join(home, ".dsh", "storages", "session_projcache", "sessions"), { recursive: true });
writeFileSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`), "{}");
writeFileSync(join(home, ".dsh", "storages", "session_projcache.json"), JSON.stringify({
	unit: { name: "session_projcache", version: 3 }, global: null,
	tables: { sessions: { [victimId]: { keep: true }, [otherId]: { keep: true } } }
}, null, 1));

// ── 假 registry + 真 Cordis Context（Service 构造需要 ctx.reflect.provide）──
const detached = [];
const registry = {
	readSessionHeader: async (id) => ({ id, cwd: id === victimId ? "D:\\proj" : undefined }),
	archiveSession: async () => {}, unarchiveSession: async () => {}, unpinSession: async () => {},
	list: () => [{ sessionIds: [victimId, otherId], detachSession: async (id) => detached.push(id) }],
	archivedSessionIds: [], pinnedSessionIds: []
};
const { Context } = await import("@deepseek-ai/cordis");
const ctx = new Context().extend({
	workspaceRegistry: registry,
	get(key) { return key === "workspaceRegistry" ? registry : undefined; }
});
const gateway = new mod.default(ctx, undefined);

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// 1) 契约面只剩 delete（体检/清扫相关方法必须不存在）
check("surface.onlyDelete", typeof gateway.delete === "function"
	&& gateway.verify === undefined && gateway.sweepShells === undefined
	&& gateway.audit === undefined && gateway.preview === undefined);

// 2) delete 全瀑布
const del = await gateway.delete({ sessionId: victimId });
check("delete.ok", del.ok === true);
check("delete.dirGone", !existsSync(victimDir));
check("delete.shardGone", !existsSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`)));
const pc = JSON.parse(readFileSync(join(home, ".dsh", "storages", "session_projcache.json"), "utf8"));
check("delete.tableEntryGone", pc.tables.sessions[victimId] === undefined);
check("delete.otherEntryKept", pc.tables.sessions[otherId] !== undefined);
check("delete.detachCalled", detached.includes(victimId));
check("delete.guardScheduled", del.removed?.guardScheduled === true);

// 3) 零误伤
check("other.intact", existsSync(otherDir));

// 4) 幂等
const del2 = await gateway.delete({ sessionId: victimId });
check("delete.idempotent", del2.ok === true);

// 5) 复活守卫：删后立刻重建目录，守卫应在 ~2s 档把它清掉
mkdirSync(victimDir, { recursive: true });
writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
check("guard.recreated", existsSync(victimDir));
await new Promise((resolve) => setTimeout(resolve, 5000));
check("guard.resurrectedRemoved", !existsSync(victimDir));
gateway.stopGuard(victimId);

// 6) 缺参报错
let threw = false;
try { await gateway.delete({}); } catch { threw = true; }
check("delete.requiresSessionId", threw);

rmSync(home, { recursive: true, force: true });
const pass = results.every(([, ok]) => ok);
console.log(pass ? "\nFINAL: ALL PASSED" : `\nFINAL: FAILED (${results.filter(([, ok]) => !ok).length} failures)`);
process.exit(pass ? 0 : 1);
