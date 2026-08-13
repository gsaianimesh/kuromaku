import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  memoryRecords,
  recordDerivations,
  recordSources,
  sources,
  type MemoryRecord,
  type MemoryType,
  type Source,
} from "../db/schema";
import { ModelJsonError, runModelJson } from "../model";
import { searchCached, type SearchResult } from "../search";
import { getWorkspace } from "../workspace";
import {
  STAGES,
  stageOutput,
  systemPromptFor,
  type EmittedRecord,
  type Stage,
} from "./stages";

/**
 * The strategy compiler (SPEC 7.2). One job, one idempotency key; re-running
 * supersedes rather than duplicates.
 *
 * Provenance is enforced here, not trusted from the model: a cited source index
 * must resolve to a source actually given to the model, and a cited URL must
 * appear in search results actually returned. Anything that fails to resolve is
 * dropped from the citation list, not from the record — the record survives,
 * flagged unsourced with confidence capped below 0.5, exactly as SPEC 7.2 says.
 */

/**
 * Total characters of source text allowed into one stage prompt.
 *
 * Sized against the tightest model budget we actually run on: Groq's free tier
 * caps several models at 8,000 tokens per minute for prompt plus completion.
 * At roughly four characters per token, 14,000 characters of sources plus the
 * instructions and prior records leaves room for a 2,500-token completion
 * inside that ceiling. Larger budgets 413 rather than degrade.
 */
const SOURCES_CHAR_BUDGET = 14_000;
const MIN_PER_SOURCE = 700;
const STAGE_MAX_TOKENS = 2500;

export type CompileProgress = (message: string) => void;

export type CompileSummary = {
  stages: Array<{
    stage: string;
    locale?: string;
    emitted: number;
    sourced: number;
    unsourced: number;
    superseded: number;
    attempts: number;
    searches?: number;
    cachedSearches?: number;
    skipped?: string;
  }>;
  totalRecords: number;
  totalUnsourced: number;
  researchAvailable: boolean;
  researchNote?: string;
};

/**
 * Renders sources within the character budget. Indices stay aligned with the
 * `sources` array so a cited index always resolves to the right row, even when
 * a source is truncated.
 */
function renderSources(rows: Source[]): { block: string; truncated: number } {
  const perSource = Math.max(
    MIN_PER_SOURCE,
    Math.floor(SOURCES_CHAR_BUDGET / Math.max(rows.length, 1)),
  );
  let truncated = 0;

  const block = rows
    .map((s, i) => {
      const full = s.rawText ?? "";
      const text = full.slice(0, perSource);
      if (text.length < full.length) truncated++;
      const note = text.length < full.length ? "\n[truncated]" : "";
      return `--- SOURCE ${i} ---\nurl: ${s.url}\ntitle: ${s.title ?? "(untitled)"}\n\n${text}${note}`;
    })
    .join("\n\n");

  return { block, truncated };
}

function renderPriorRecords(rows: MemoryRecord[]): string {
  if (rows.length === 0) return "(none)";
  return rows
    .map((r) => `- [${r.type}] ${r.key}: ${JSON.stringify(r.value)}`)
    .join("\n");
}

function renderSearch(results: SearchResult[]): string {
  if (results.length === 0) return "(no search results available)";
  return results
    .map((r, i) => `--- RESULT ${i} ---\nurl: ${r.url}\ntitle: ${r.title}\n${r.snippet}`)
    .join("\n\n");
}

/**
 * Writes one record, superseding any active record with the same type/key/locale.
 * Append-only: the old row is flipped to `superseded` and the new row points at
 * it (SPEC section 3).
 */
async function writeRecord(
  workspaceId: string,
  type: MemoryType,
  locale: string,
  emitted: EmittedRecord,
  citations: Array<{ sourceId?: string; url?: string; snippet?: string }>,
): Promise<{ superseded: boolean; recordId: string }> {
  const db = getDb();

  const [prior] = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.type, type),
        eq(memoryRecords.key, emitted.key),
        eq(memoryRecords.locale, locale),
        eq(memoryRecords.status, "active"),
      ),
    )
    .limit(1);

  // Unsourced records are capped below 0.5 regardless of what the model claimed.
  const confidence =
    citations.length === 0 ? Math.min(emitted.confidence, 0.4) : emitted.confidence;

  const [created] = await db
    .insert(memoryRecords)
    .values({
      workspaceId,
      type,
      key: emitted.key,
      value: emitted.value,
      locale,
      confidence,
      status: "active",
      version: prior ? prior.version + 1 : 1,
      supersedesId: prior?.id ?? null,
      origin: "compiled",
    })
    .returning();

  if (prior) {
    await db
      .update(memoryRecords)
      .set({ status: "superseded" })
      .where(eq(memoryRecords.id, prior.id));
  }

  if (citations.length > 0) {
    await db.insert(recordSources).values(
      citations.map((c) => ({
        recordId: created.id,
        sourceId: c.sourceId ?? null,
        url: c.url ?? null,
        snippet: c.snippet ?? null,
      })),
    );
  }

  return { superseded: Boolean(prior), recordId: created.id };
}

/** Search queries for the competitors stage, derived from compiled positioning. */
function competitorQueries(workspaceName: string, prior: MemoryRecord[]): string[] {
  const positioning = prior.filter((r) => r.type === "positioning");
  const queries = new Set<string>();

  queries.add(`${workspaceName} alternatives`);
  queries.add(`${workspaceName} competitors`);

  for (const p of positioning.slice(0, 2)) {
    const v = p.value as { category?: string; againstAlternative?: string };
    if (v.category) queries.add(`best ${v.category} tools 2026`);
    if (v.againstAlternative) queries.add(`${v.againstAlternative} alternatives`);
  }

  return [...queries].slice(0, 5);
}

export async function compileWorkspace(
  workspaceId: string,
  jobId: string,
  log: CompileProgress = () => {},
): Promise<CompileSummary> {
  const db = getDb();
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new Error("Workspace not found");

  const sourceRows = await db
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId));

  if (sourceRows.length === 0) {
    throw new Error(
      "No sources to compile from. Crawl the domain first — the compiler will not invent a memory from nothing.",
    );
  }

  const rendered = renderSources(sourceRows);
  const sourceBlock = rendered.block;
  log(
    `compiling from ${sourceRows.length} source(s)${rendered.truncated > 0 ? ` (${rendered.truncated} truncated to fit the model's token budget)` : ""}, locales: ${workspace.locales.join(", ")}`,
  );
  const summary: CompileSummary = {
    stages: [],
    totalRecords: 0,
    totalUnsourced: 0,
    researchAvailable: false,
  };

  // Records compiled during this run, used as context for later stages.
  const compiled: MemoryRecord[] = [];
  /** Stage failures, re-raised once every stage has had its turn. */
  const failures: string[] = [];

  for (const stage of STAGES) {
    const locales = stage.perLocale ? workspace.locales : [null];

    for (const locale of locales) {
      const effectiveLocale = locale ?? "en";
      const label = locale ? `${stage.id} (${locale})` : stage.id;
      log(`stage ${label}: starting`);

      // Research, for the one stage that needs it.
      let searchBlock = "";
      let searchResults: SearchResult[] = [];
      let searches = 0;
      let cachedSearches = 0;

      if (stage.runsResearch) {
        const queries = competitorQueries(workspace.name, compiled);
        for (const q of queries) {
          const outcome = await searchCached(workspaceId, q);
          searches++;
          if (outcome.fromCache) cachedSearches++;
          if (outcome.unavailable) {
            summary.researchNote = outcome.unavailable;
            log(`  search "${q}": unavailable — ${outcome.unavailable}`);
          } else {
            summary.researchAvailable = true;
            searchResults.push(...outcome.results);
            log(
              `  search "${q}": ${outcome.results.length} result(s)${outcome.fromCache ? " (cache hit)" : ""}`,
            );
          }
        }
        // Dedup by URL — several queries commonly surface the same page.
        const seen = new Set<string>();
        searchResults = searchResults.filter((r) =>
          seen.has(r.url) ? false : (seen.add(r.url), true),
        );
        searchBlock = `\n\n=== SEARCH RESULTS ===\n${renderSearch(searchResults)}`;
      }

      const dependencies = compiled.filter((r) =>
        stage.dependsOn.some((d) => STAGES.find((s) => s.id === d)?.memoryType === r.type),
      );

      const localeNote = stage.perLocale
        ? `\n\nLocale for this stage: "${effectiveLocale}". Only source material written in this locale counts as grounding for a voice rule.`
        : "";

      /*
       * Keys already in memory for this type. Models pick a different phrasing
       * each run, so without this a re-compile invents new keys and nothing
       * supersedes. Reusing a key is what links the new version to the old one
       * and keeps the history chain intact (SPEC 7.2, 7.3).
       */
      const existingKeys = (
        await db
          .select({ key: memoryRecords.key })
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.workspaceId, workspaceId),
              eq(memoryRecords.type, stage.memoryType),
              eq(memoryRecords.locale, effectiveLocale),
              eq(memoryRecords.status, "active"),
            ),
          )
      ).map((r) => r.key);

      const keyNote =
        existingKeys.length > 0
          ? `\n\n=== EXISTING KEYS FOR THIS TYPE ===
${existingKeys.map((k) => `- ${k}`).join("\n")}

Reuse an existing key verbatim whenever your record is about the same thing, even if you would word it differently. That is how a re-compile updates a record instead of creating a second one. Use a new key only for something genuinely not in the list.`
          : "";

      // Only the stages that read the company's own prose get raw page text.
      // The rest work from compiled records — the shared strategy layer doing
      // its job, and the reason each prompt stays inside the token budget.
      const sourcesSection = stage.needsSources
        ? `\n\n=== SOURCES ===\n${sourceBlock}`
        : `\n\n(Raw page text is not supplied to this stage. Ground records in the compiled records above; cite a source index only if the record above names one.)`;

      const userContent = `Company: ${workspace.name} (${workspace.domain})
Locales in this workspace: ${workspace.locales.join(", ")}${localeNote}

=== PREVIOUSLY COMPILED RECORDS ===
${renderPriorRecords(dependencies)}${keyNote}${sourcesSection}${searchBlock}`;

      let emitted: EmittedRecord[];
      let attempts = 0;
      try {
        const result = await runModelJson(
          {
            workspaceId,
            jobId,
            agentId: `compiler:${stage.id}`,
            task: "compile",
            system: systemPromptFor(stage),
            messages: [{ role: "user", content: userContent }],
            maxTokens: STAGE_MAX_TOKENS,
            onWait: (m) => log(`  ${m}`),
          },
          stageOutput,
        );
        emitted = result.value.records;
        attempts = result.attempts;
      } catch (e) {
        if (e instanceof ModelJsonError) {
          /*
           * SPEC 7.2 says fail the job with the raw output stored. The raw
           * output is already on the agent_runs row, and the job does fail —
           * but at the end, not here. Throwing mid-chain would discard every
           * stage that already succeeded, and a memory that is eight-ninths
           * compiled is far more useful than none. The failure is recorded and
           * re-raised once the remaining stages have had their turn.
           */
          const detail = `Stage "${label}" failed: ${e.message}`;
          log(`stage ${label}: FAILED — ${e.message}`);
          failures.push(detail);
          summary.stages.push({
            stage: stage.id,
            locale: stage.perLocale ? effectiveLocale : undefined,
            emitted: 0,
            sourced: 0,
            unsourced: 0,
            superseded: 0,
            attempts: 2,
            skipped: e.message,
          });
          continue;
        }
        throw e;
      }

      let sourced = 0;
      let unsourced = 0;
      let supersededCount = 0;
      let edges = 0;

      // Ids of the records that were in this stage's prompt. Every record the
      // stage emits is derived from all of them — the stage saw them together
      // and cannot say which one it leaned on, so the edge set is the whole
      // dependency slice rather than a guess at a subset.
      const dependencyIds = dependencies.map((d) => d.id);

      for (const record of emitted) {
        // Resolve citations against what the model was actually shown.
        const citations: Array<{ sourceId?: string; url?: string; snippet?: string }> = [];

        for (const idx of record.sourceIndices) {
          const source = sourceRows[idx];
          if (source) {
            citations.push({
              sourceId: source.id,
              url: source.url,
              snippet: record.snippet,
            });
          }
        }
        for (const url of record.sourceUrls) {
          if (searchResults.some((r) => r.url === url)) {
            citations.push({ url, snippet: record.snippet });
          }
        }

        const { superseded, recordId } = await writeRecord(
          workspaceId,
          stage.memoryType,
          effectiveLocale,
          record,
          citations,
        );

        if (dependencyIds.length > 0) {
          await db
            .insert(recordDerivations)
            .values(
              dependencyIds.map((sourceRecordId) => ({
                workspaceId,
                derivedRecordId: recordId,
                sourceRecordId,
                stage: stage.id,
              })),
            )
            .onConflictDoNothing();
          edges += dependencyIds.length;
        }

        if (citations.length > 0) sourced++;
        else unsourced++;
        if (superseded) supersededCount++;
      }

      /*
       * A stage's output is authoritative for its type and locale. Any record
       * that survived from a previous compile but was not re-emitted is
       * superseded rather than left active — otherwise a re-compile that drops
       * a fact leaves the stale one sitting in memory as though it were still
       * current, which is exactly the defect this system exists to fix.
       *
       * Nothing is deleted: the rows stay, marked superseded, and remain
       * visible in history.
       */
      if (emitted.length > 0) {
        const emittedKeys = new Set(emitted.map((r) => r.key));
        const orphans = existingKeys.filter((k) => !emittedKeys.has(k));
        if (orphans.length > 0) {
          await db
            .update(memoryRecords)
            .set({ status: "superseded" })
            .where(
              and(
                eq(memoryRecords.workspaceId, workspaceId),
                eq(memoryRecords.type, stage.memoryType),
                eq(memoryRecords.locale, effectiveLocale),
                eq(memoryRecords.status, "active"),
                inArray(memoryRecords.key, orphans),
              ),
            );
          supersededCount += orphans.length;
          log(
            `stage ${label}: ${orphans.length} record(s) not re-emitted, superseded: ${orphans.join(", ")}`,
          );
        }
      }

      // Reload what we just wrote so later stages see real rows.
      if (emitted.length > 0) {
        const fresh = await db
          .select()
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.workspaceId, workspaceId),
              eq(memoryRecords.type, stage.memoryType),
              eq(memoryRecords.status, "active"),
              inArray(
                memoryRecords.key,
                emitted.map((r) => r.key),
              ),
            ),
          );
        compiled.push(...fresh);
      }

      summary.stages.push({
        stage: stage.id,
        locale: stage.perLocale ? effectiveLocale : undefined,
        emitted: emitted.length,
        sourced,
        unsourced,
        superseded: supersededCount,
        attempts,
        ...(stage.runsResearch ? { searches, cachedSearches } : {}),
      });
      summary.totalRecords += emitted.length;
      summary.totalUnsourced += unsourced;

      log(
        `stage ${label}: ${emitted.length} record(s), ${sourced} sourced, ${unsourced} unsourced, ${supersededCount} superseded, ${edges} derivation edge(s)`,
      );
    }
  }

  log(
    `compile done: ${summary.totalRecords} record(s), ${summary.totalUnsourced} unsourced, ${failures.length} stage(s) failed`,
  );

  if (failures.length > 0) {
    // Everything that compiled is committed and visible; the job still fails so
    // the failure is not silently swallowed (SPEC 7.2).
    throw new Error(
      `${failures.length} stage(s) failed after retry. Records from the stages that succeeded were kept. Raw model output for each failure is on this job's run log.\n${failures.join("\n")}`,
    );
  }

  return summary;
}

export type { Stage };
