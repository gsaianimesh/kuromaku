"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DEFAULT_MAX_PAGES, toOrigin } from "@/lib/ingest/crawl";
import { enqueue } from "@/lib/jobs/queue";
import { runWorker } from "@/lib/jobs/worker";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";

export type CrawlState = {
  ok: boolean;
  message: string;
  jobId?: string;
} | null;

const schema = z.object({
  domain: z.string().trim().min(3, "Enter a domain"),
  maxPages: z.coerce.number().int().min(1).max(200),
});

export async function startCrawlAction(
  _prev: CrawlState,
  formData: FormData,
): Promise<CrawlState> {
  const parsed = schema.safeParse({
    domain: formData.get("domain"),
    maxPages: formData.get("maxPages") ?? DEFAULT_MAX_PAGES,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  let origin: string;
  try {
    origin = toOrigin(parsed.data.domain);
  } catch {
    return { ok: false, message: `"${parsed.data.domain}" is not a valid domain.` };
  }

  const ws = await getOrCreateDefaultWorkspace();
  const { job, created } = await enqueue({
    workspaceId: ws.id,
    type: "crawl_site",
    // Scoped to the origin, so double-clicking cannot start two crawls of the
    // same site. A completed crawl releases the key, so re-crawling works.
    idempotencyKey: `crawl:${ws.id}:${origin}`,
    payload: { domain: origin, maxPages: parsed.data.maxPages },
    reason: `Manual crawl of ${origin}, up to ${parsed.data.maxPages} pages.`,
  });

  revalidatePath("/sources");
  revalidatePath("/jobs");

  return {
    ok: true,
    jobId: job.id,
    message: created
      ? `Crawl of ${origin} queued. Run the worker to start it.`
      : `A crawl of ${origin} is already ${job.status}. Returned the existing job rather than starting a second one.`,
  };
}

/** Runs the worker and returns once the queue is drained. */
export async function runCrawlNowAction(): Promise<{
  processed: number;
  log: string[];
  outcome: string | null;
}> {
  const result = await runWorker({ maxJobs: 3, budgetMs: 55_000 });
  revalidatePath("/sources");
  revalidatePath("/jobs");
  const crawl = result.processed.find((p) => p.type === "crawl_site");
  return {
    processed: result.processed.length,
    log: crawl?.log ?? [],
    outcome: crawl ? (crawl.error ? `${crawl.outcome}: ${crawl.error}` : crawl.outcome) : null,
  };
}
