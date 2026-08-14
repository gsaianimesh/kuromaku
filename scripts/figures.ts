/**
 * Re-derives every figure the submission document cites, straight from the
 * database.
 *
 *   npm run figures
 *
 * The document quotes about twenty numbers — record counts, confidence caps,
 * derivation edges, critic scores, edit distances. Each one was true when it
 * was written and several stopped being true the next time the pipeline ran.
 * Rather than trusting a re-read, this prints the current value of every one of
 * them so the prose can be checked against the database line by line.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

type Row = { label: string; value: string };
const rows: Row[] = [];
function put(label: string, value: string | number) {
  rows.push({ label, value: String(value) });
}

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { sql } = await import("drizzle-orm");
  const { getOrCreateDefaultWorkspace } = await import("../src/lib/workspace");
  const { listActiveMemory, memoryStats } = await import("../src/lib/memory");
  const { reviewStats } = await import("../src/lib/review");
  const { runPlanner } = await import("../src/lib/planner");

  const db = getDb();
  const ws = await getOrCreateDefaultWorkspace();

  // ---------------------------------------------------------------- memory
  const stats = await memoryStats(ws.id);
  put("memory: active records", stats.total);
  put("memory: sourced", stats.sourced);
  put("memory: derived", stats.derived);
  put("memory: ungrounded", stats.unsourced);
  put(
    "memory: ungrounded share",
    `${((stats.unsourced / Math.max(stats.total, 1)) * 100).toFixed(0)}%`,
  );
  put("memory: average confidence", stats.averageConfidence?.toFixed(3) ?? "—");
  put("memory: locales", stats.locales.join(", "));

  const versions = await db.execute<{
    active: number;
    superseded: number;
    chained: number;
    maxv: number;
  }>(sql`
    select
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'superseded')::int as superseded,
      count(*) filter (where supersedes_id is not null)::int as chained,
      coalesce(max(version), 0)::int as maxv
    from memory_records where workspace_id = ${ws.id}::uuid
  `);
  const v = versions.rows[0];
  put("versions: active", v.active);
  put("versions: superseded", v.superseded);
  put("versions: rows carrying a predecessor", v.chained);
  put("versions: highest version reached", v.maxv);

  const memory = await listActiveMemory(ws.id);
  const ungrounded = memory.filter((r) => r.unsourced);
  put(
    "confidence: max among ungrounded",
    ungrounded.length === 0
      ? "n/a (none ungrounded)"
      : Math.max(...ungrounded.map((r) => r.confidence)).toFixed(2),
  );
  const derived = memory.filter((r) => r.grounding === "derived");
  put(
    "confidence: max among derived",
    derived.length === 0 ? "n/a" : Math.max(...derived.map((r) => r.confidence)).toFixed(2),
  );

  const edges = await db.execute<{ n: number; maxdepth: number }>(sql`
    with recursive chain(id, depth, path) as (
      select derived_record_id, 1, array[source_record_id, derived_record_id]
      from record_derivations
      union all
      select rd.derived_record_id, c.depth + 1, c.path || rd.derived_record_id
      from record_derivations rd
      join chain c on rd.source_record_id = c.id
      where c.depth < 16 and not rd.derived_record_id = any(c.path)
    )
    select (select count(*)::int from record_derivations) as n,
           coalesce(max(depth), 0)::int as maxdepth
    from chain
  `);
  put("derivations: edges", edges.rows[0].n);
  put("derivations: longest chain (hops)", edges.rows[0].maxdepth);

  // ------------------------------------------------------------- artifacts
  const rs = await reviewStats(ws.id);
  put("artifacts: by status", JSON.stringify(rs.byStatus));
  put("reviews: total", rs.totalReviews);
  put("reviews: with an edit distance", rs.editsWithDistance);
  put(
    "reviews: average edit distance",
    rs.averageEditDistance === null ? "none recorded" : rs.averageEditDistance.toFixed(4),
  );
  put(
    "critic: average score",
    rs.averageCriticScore === null ? "none" : rs.averageCriticScore.toFixed(2),
  );

  const critic = await db.execute<{ maxs: number; mins: number }>(sql`
    select max(critic_score)::float as maxs, min(critic_score)::float as mins
    from artifacts where workspace_id = ${ws.id}::uuid and critic_score is not null
  `);
  put("critic: highest score", critic.rows[0]?.maxs?.toFixed(2) ?? "—");
  put("critic: lowest score", critic.rows[0]?.mins?.toFixed(2) ?? "—");

  const ev = await db.execute<{ maxn: number; zero: number }>(sql`
    select coalesce(max(n), 0)::int as maxn,
           count(*) filter (where n = 0)::int as zero
    from (
      select a.id, count(e.id)::int as n
      from artifacts a
      left join artifact_evidence e on e.artifact_id = a.id
      where a.workspace_id = ${ws.id}::uuid
      group by a.id
    ) t
  `);
  put("evidence: most items on one draft", ev.rows[0].maxn);
  put("evidence: artifacts with none", ev.rows[0].zero);

  // --------------------------------------------------------------- planner
  const plan = await runPlanner(ws.id, () => {});
  put("planner: scheduled", plan.scheduled.length);
  put("planner: skipped", plan.skipped.length);
  put(
    "planner: coverage gaps",
    plan.gaps.map((g) => `${g.channel} (rank ${g.rank})`).join(", ") || "none",
  );

  // ---------------------------------------------------------------- model
  const runs = await db.execute<{ n: number; models: string; cost: number }>(sql`
    select count(*)::int as n,
           string_agg(distinct model, ', ') as models,
           coalesce(sum(cost_usd), 0)::float as cost
    from agent_runs
  `);
  put("model calls logged", runs.rows[0].n);
  put("models used", runs.rows[0].models ?? "—");
  put("total logged cost (USD)", runs.rows[0].cost.toFixed(4));

  const srcs = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from sources where workspace_id = ${ws.id}::uuid
  `);
  put("sources crawled", srcs.rows[0].n);

  const width = Math.max(...rows.map((r) => r.label.length));
  console.log();
  for (const r of rows) console.log(`${r.label.padEnd(width)}  ${r.value}`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
