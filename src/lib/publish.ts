import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { artifacts, observations, type Artifact } from "./db/schema";

/**
 * Publishing (SPEC 7.8) and performance intake (SPEC 7.9).
 *
 * SPEC section 4 is absolute here: no agent may post anywhere. Nothing in this
 * module makes an outbound write to any platform. For Reddit and Hacker News in
 * particular, automated posting violates their rules, so the only supported
 * flow is copy to clipboard plus a human confirming the URL afterwards.
 */

export type PublishTarget = {
  channel: string;
  /** How a human actually gets this live. */
  method: "copy_and_confirm" | "file_export";
  instructions: string;
  /** Where to go to post it, for convenience only. */
  composeUrl?: string;
};

export function publishTargetFor(channel: string): PublishTarget {
  switch (channel) {
    case "hacker_news":
      return {
        channel,
        method: "copy_and_confirm",
        instructions:
          "Copy the text, submit it yourself, then paste the resulting URL below. Automated posting to Hacker News is against its rules and is not implemented.",
        composeUrl: "https://news.ycombinator.com/submit",
      };
    case "reddit":
      return {
        channel,
        method: "copy_and_confirm",
        instructions:
          "Copy the text, post it yourself in the relevant subreddit, then paste the resulting URL below. Automated posting to Reddit is against its rules and is not implemented.",
        composeUrl: "https://www.reddit.com/submit",
      };
    case "x":
      return {
        channel,
        method: "copy_and_confirm",
        instructions:
          "Copy the text, post it yourself, then paste the resulting URL below.",
        composeUrl: "https://x.com/compose/post",
      };
    case "product_hunt":
      return {
        channel,
        method: "copy_and_confirm",
        instructions:
          "Copy the text, post it as a maker comment, then paste the resulting URL below.",
      };
    case "content":
    case "seo":
      return {
        channel,
        method: "file_export",
        instructions:
          "Export as Markdown and commit it to your site repository. Paste the live URL below once it ships.",
      };
    default:
      return {
        channel,
        method: "copy_and_confirm",
        instructions:
          "Copy the text, publish it yourself, then paste the resulting URL below.",
      };
  }
}

/** Markdown export for file-based channels (SPEC 7.8). */
export function toMarkdown(artifact: Artifact): string {
  const body = artifact.contentFinal ?? artifact.content;
  const front = [
    "---",
    `channel: ${artifact.channel}`,
    `kind: ${artifact.kind}`,
    `agent: ${artifact.agentId}`,
    `locale: ${artifact.locale}`,
    `status: ${artifact.status}`,
    `created_at: ${artifact.createdAt.toISOString()}`,
    artifact.criticScore !== null ? `critic_score: ${artifact.criticScore}` : null,
    "---",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return `${front}${body}\n`;
}

export function exportFilename(artifact: Artifact): string {
  const slug = (artifact.contentFinal ?? artifact.content)
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${artifact.createdAt.toISOString().slice(0, 10)}-${slug || artifact.id.slice(0, 8)}.md`;
}

/**
 * "I posted this, here is the URL." The only way an artifact becomes published.
 */
export async function markAsPosted(
  artifactId: string,
  externalUrl: string,
): Promise<void> {
  const url = externalUrl.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new Error(
      "That is not a valid URL. Publishing requires the real link so performance can be attributed to it.",
    );
  }

  const db = getDb();
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  if (!artifact) throw new Error("Artifact not found");
  if (artifact.status !== "approved") {
    throw new Error(
      `Only an approved artifact can be marked as posted. This one is ${artifact.status}.`,
    );
  }

  await db
    .update(artifacts)
    .set({ status: "published", externalUrl: url, publishedAt: new Date() })
    .where(eq(artifacts.id, artifactId));
}

// ---------------------------------------------------------------------------
// Observations (SPEC 7.9) — recorded, never generated
// ---------------------------------------------------------------------------

export const KNOWN_METRICS = [
  "impressions",
  "clicks",
  "upvotes",
  "comments",
  "replies",
  "signups",
  "position",
] as const;

export async function recordObservation(input: {
  workspaceId: string;
  artifactId: string | null;
  metric: string;
  value: number;
  source: "manual" | "gsc" | "import";
  observedAt?: Date;
}): Promise<void> {
  if (!Number.isFinite(input.value)) {
    throw new Error("An observation needs a real number");
  }
  const db = getDb();
  await db.insert(observations).values({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    metric: input.metric.trim().toLowerCase(),
    value: input.value.toString(),
    source: input.source,
    observedAt: input.observedAt ?? new Date(),
  });
}

export async function listObservations(workspaceId: string, limit = 100) {
  const db = getDb();
  return db
    .select({
      id: observations.id,
      metric: observations.metric,
      value: observations.value,
      source: observations.source,
      observedAt: observations.observedAt,
      artifactId: observations.artifactId,
      channel: artifacts.channel,
      agentId: artifacts.agentId,
      externalUrl: artifacts.externalUrl,
    })
    .from(observations)
    .leftJoin(artifacts, eq(observations.artifactId, artifacts.id))
    .where(eq(observations.workspaceId, workspaceId))
    .orderBy(desc(observations.observedAt))
    .limit(limit);
}

export async function observationSummary(workspaceId: string): Promise<{
  total: number;
  byMetric: Array<{ metric: string; total: number; observations: number }>;
  byChannel: Array<{ channel: string; observations: number }>;
}> {
  const db = getDb();

  const [totals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(observations)
    .where(eq(observations.workspaceId, workspaceId));

  const byMetric = await db
    .select({
      metric: observations.metric,
      total: sql<number>`sum(${observations.value})`,
      observations: sql<number>`count(*)::int`,
    })
    .from(observations)
    .where(eq(observations.workspaceId, workspaceId))
    .groupBy(observations.metric);

  const byChannel = await db
    .select({
      channel: artifacts.channel,
      observations: sql<number>`count(*)::int`,
    })
    .from(observations)
    .innerJoin(artifacts, eq(observations.artifactId, artifacts.id))
    .where(eq(observations.workspaceId, workspaceId))
    .groupBy(artifacts.channel);

  return {
    total: totals?.n ?? 0,
    byMetric: byMetric.map((m) => ({
      metric: m.metric,
      total: Number(m.total),
      observations: m.observations,
    })),
    byChannel,
  };
}

export async function publishableArtifacts(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        sql`${artifacts.status} in ('approved', 'published')`,
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(50);
}
