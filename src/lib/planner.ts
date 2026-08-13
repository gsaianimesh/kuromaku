import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  artifacts,
  coverageGaps,
  jobs,
  memoryRecords,
  observations,
} from "./db/schema";
import { agentsForChannel } from "./agents/registry";
import { enqueue } from "./jobs/queue";

/**
 * The planner (SPEC 7.4). Reads channel priorities, open roadmap items, recent
 * observations and recent artifact history, then produces jobs — each carrying
 * a plain-language reason.
 *
 * The behaviour that matters most: a prioritised channel with no registered
 * agent produces a visible coverage gap, not silence (SPEC section 3).
 */

const RECENT_WINDOW_DAYS = 14;

export type PlanResult = {
  scheduled: Array<{ channel: string; agentId: string; reason: string; jobId: string }>;
  gaps: Array<{ channel: string; rank: number | null; rationale: string }>;
  skipped: Array<{ channel: string; why: string }>;
  observationsConsidered: number;
  roadmapItemsConsidered: number;
};

export async function runPlanner(
  workspaceId: string,
  log: (m: string) => void = () => {},
): Promise<PlanResult> {
  const db = getDb();
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000);

  const priorities = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.type, "channel_priority"),
        eq(memoryRecords.status, "active"),
      ),
    );

  const roadmap = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.type, "roadmap_item"),
        eq(memoryRecords.status, "active"),
      ),
    );

  if (priorities.length === 0) {
    log("no channel priorities in memory — compile the strategy first");
    return {
      scheduled: [],
      gaps: [],
      skipped: [],
      observationsConsidered: 0,
      roadmapItemsConsidered: 0,
    };
  }

  // Recent artifacts per channel, and whether any of them have been observed.
  const recent = await db
    .select({
      channel: artifacts.channel,
      total: sql<number>`count(*)::int`,
      observed: sql<number>`count(distinct ${observations.artifactId})::int`,
    })
    .from(artifacts)
    .leftJoin(observations, eq(observations.artifactId, artifacts.id))
    .where(
      and(eq(artifacts.workspaceId, workspaceId), gte(artifacts.createdAt, since)),
    )
    .groupBy(artifacts.channel);

  const recentByChannel = new Map(recent.map((r) => [r.channel, r]));

  const [obsCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(observations)
    .where(
      and(
        eq(observations.workspaceId, workspaceId),
        gte(observations.observedAt, since),
      ),
    );

  const ranked = priorities
    .map((p) => {
      const v = p.value as { channel?: string; rank?: number; rationale?: string };
      return {
        record: p,
        channel: (v.channel ?? p.key).toLowerCase().replace(/\s+/g, "_"),
        rank: typeof v.rank === "number" ? v.rank : null,
        rationale: v.rationale ?? "",
      };
    })
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const result: PlanResult = {
    scheduled: [],
    gaps: [],
    skipped: [],
    observationsConsidered: obsCount?.n ?? 0,
    roadmapItemsConsidered: roadmap.length,
  };

  for (const entry of ranked) {
    const agents = agentsForChannel(entry.channel);

    if (agents.length === 0) {
      /*
       * The coverage gap. Okara's defect 1 was ranking a channel highly and
       * then having no agent for it, with nothing said. Here it becomes a row
       * someone has to look at.
       */
      const rationale =
        `Ranked ${entry.rank ?? "unranked"} in the strategy${entry.rationale ? ` — ${entry.rationale}` : ""}, ` +
        `but no registered agent serves this channel, so nothing can be drafted for it.`;

      await db
        .insert(coverageGaps)
        .values({
          workspaceId,
          channel: entry.channel,
          priorityRank: entry.rank,
          rationale,
          status: "open",
        })
        .onConflictDoUpdate({
          target: [coverageGaps.workspaceId, coverageGaps.channel],
          set: { priorityRank: entry.rank, rationale },
        });

      result.gaps.push({ channel: entry.channel, rank: entry.rank, rationale });
      log(`coverage gap: ${entry.channel} (rank ${entry.rank ?? "?"}) has no agent`);
      continue;
    }

    /*
     * SPEC 7.4: avoid scheduling the same channel repeatedly if its recent
     * artifacts have no observations. Drafting more into a channel that has
     * produced no measurable result is exactly the loop this system exists to
     * break.
     */
    const recentStats = recentByChannel.get(entry.channel);
    if (recentStats && recentStats.total >= 2 && recentStats.observed === 0) {
      const why =
        `${recentStats.total} artifact(s) in the last ${RECENT_WINDOW_DAYS} days and no observations recorded ` +
        `for any of them. Record performance for this channel before drafting more.`;
      result.skipped.push({ channel: entry.channel, why });
      log(`skip ${entry.channel}: ${why}`);
      continue;
    }

    const agent = agents[0];
    const reason =
      `Channel ranked ${entry.rank ?? "unranked"} in the compiled strategy` +
      `${entry.rationale ? ` (${entry.rationale})` : ""}. ` +
      `${agent.displayName} covers it` +
      `${recentStats ? `, and ${recentStats.observed} of ${recentStats.total} recent artifact(s) here have observations` : ", and nothing has been drafted for it recently"}.`;

    // A stable key per channel per day: re-running the planner the same day
    // does not pile up duplicate work.
    const day = new Date().toISOString().slice(0, 10);
    const { job, created } = await enqueue({
      workspaceId,
      type: "run_agent",
      idempotencyKey: `agent:${workspaceId}:${agent.id}:${entry.channel}:${day}`,
      payload: { agentId: agent.id, channel: entry.channel, locale: "en" },
      reason,
    });

    if (created) {
      result.scheduled.push({
        channel: entry.channel,
        agentId: agent.id,
        reason,
        jobId: job.id,
      });
      log(`scheduled ${agent.id} for ${entry.channel}`);
    } else {
      result.skipped.push({
        channel: entry.channel,
        why: `A job for this channel is already ${job.status} today.`,
      });
    }
  }

  /*
   * Roadmap items become jobs with real status (SPEC 7.4), which is the fix for
   * defect 2 — the 30-day roadmap that was empty checkboxes in a PDF.
   */
  for (const item of roadmap) {
    const v = item.value as {
      title?: string;
      channel?: string;
      description?: string;
    };
    const channel = (v.channel ?? "").toLowerCase().replace(/\s+/g, "_");
    const agents = agentsForChannel(channel);
    if (agents.length === 0) continue;

    const reason = `Roadmap item "${v.title ?? item.key}": ${v.description ?? "no description"}`;
    const { job, created } = await enqueue({
      workspaceId,
      type: "run_agent",
      idempotencyKey: `roadmap:${workspaceId}:${item.key}`,
      payload: {
        agentId: agents[0].id,
        channel,
        locale: "en",
        roadmapKey: item.key,
      },
      reason,
    });

    if (created) {
      result.scheduled.push({
        channel,
        agentId: agents[0].id,
        reason,
        jobId: job.id,
      });
      log(`scheduled roadmap item ${item.key} on ${channel}`);
    }
  }

  log(
    `planner: ${result.scheduled.length} scheduled, ${result.gaps.length} coverage gap(s), ${result.skipped.length} skipped`,
  );
  return result;
}

export async function listCoverageGaps(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(coverageGaps)
    .where(eq(coverageGaps.workspaceId, workspaceId))
    .orderBy(coverageGaps.priorityRank);
}

export async function acknowledgeGap(id: string) {
  const db = getDb();
  await db
    .update(coverageGaps)
    .set({ status: "acknowledged" })
    .where(eq(coverageGaps.id, id));
}

/** Recent planner-scheduled jobs, for the planner screen. */
export async function recentPlannedJobs(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, workspaceId),
        inArray(jobs.type, ["run_agent"]),
        isNotNull(jobs.reason),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(25);
}
