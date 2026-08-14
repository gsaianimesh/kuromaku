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
 * flagged and capped, exactly as SPEC 7.2 says. What it is capped to depends on
 * whether anything else grounds it: see `writeRecord`.
 */

/**
 * Total characters of source text allowed into one stage prompt.
 *
 * Sized against the tightest model budget we actually run on: Groq's free tier
 * caps gpt-oss-120b at 8,000 tokens per minute for prompt plus completion, and
 * that ceiling applies to a single request as well. At roughly four characters
 * per token, 10,000 characters of sources plus the instructions and a capped
 * slice of prior records leaves room for a 2,200-token completion inside that
 * ceiling. Larger budgets 413 rather than degrade.
 */
const SOURCES_CHAR_BUDGET = 10_000;
const MIN_PER_SOURCE = 600;
const STAGE_MAX_TOKENS = 2000;

/**
 * The whole prompt has to fit under the provider's per-minute token limit,
 * because that limit applies to a single request too: exceed it and the call is
 * rejected outright rather than queued.
 *
 * Budgeting each section separately did not achieve that. Sources were capped,
 * prior records were not, and the competitors stage adds a search block that
 * nothing measured — the three together came to 8,334 tokens against a ceiling
 * of 8,000 and the stage failed after the crawl had already run. This is the
 * check that looks at the assembled prompt instead of its parts.
 */
const REQUEST_TOKEN_CEILING = 8_000;
const CHARS_PER_TOKEN = 4;

/** Deliberately crude and deliberately pessimistic; it only has to be a bound. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Trims the assembled prompt to fit, cutting the sections that can afford it
 * first. Returns what was cut so the job log says so rather than the reader
 * wondering why a stage saw less than the previous one.
 */
function fitPrompt(
  sections: { sources: string; search: string; priors: string; fixed: string },
  completionTokens: number,
): { sources: string; search: string; priors: string; note: string | null } {
  const room = REQUEST_TOKEN_CEILING - completionTokens - estimateTokens(sections.fixed);
  let { sources, search, priors } = sections;
  const cuts: string[] = [];

  // Search results first: they are the most redundant, several per query.
  for (const key of ["search", "sources", "priors"] as const) {
    const total = estimateTokens(sources) + estimateTokens(search) + estimateTokens(priors);
    if (total <= room) break;

    const over = (total - room) * CHARS_PER_TOKEN;
    const current = key === "search" ? search : key === "sources" ? sources : priors;
    if (current.length === 0) continue;

    const keep = Math.max(0, current.length - over);
    const trimmed = current.slice(0, keep);
    cuts.push(`${key} ${current.length}→${trimmed.length} chars`);
    if (key === "search") search = trimmed;
    else if (key === "sources") sources = trimmed;
    else priors = trimmed;
  }

  return {
    sources,
    search,
    priors,
    note: cuts.length > 0 ? `trimmed to fit the request ceiling: ${cuts.join(", ")}` : null,
  };
}

/**
 * Prior records are the other half of a stage prompt and they grow with the
 * memory. Left uncapped they pushed the late stages over the same ceiling the
 * source budget exists to respect — the budget was only ever enforced on the
 * half that happened to be measured.
 */
const PRIOR_RECORDS_CHAR_BUDGET = 7_000;

export type CompileProgress = (message: string) => void;

export type CompileSummary = {
  stages: Array<{
    stage: string;
    locale?: string;
    emitted: number;
    sourced: number;
    /** No citation of its own, but compiled from records that have one. */
    derived: number;
    /** Neither a citation nor a parent record. This is what the warning is for. */
    ungrounded: number;
    superseded: number;
    attempts: number;
    searches?: number;
    cachedSearches?: number;
    skipped?: string;
  }>;
  totalRecords: number;
  totalUngrounded: number;
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

  // Highest confidence first, so if the budget cuts anything it cuts the
  // records the compiler is least sure of rather than an arbitrary tail.
  const ordered = [...rows].sort((a, b) => b.confidence - a.confidence);
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const r of ordered) {
    const line = `- [${r.type}] ${r.key}: ${JSON.stringify(r.value)}`;
    if (used + line.length > PRIOR_RECORDS_CHAR_BUDGET && lines.length > 0) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (dropped > 0) {
    lines.push(`[${dropped} lower-confidence record(s) omitted for length]`);
  }
  return lines.join("\n");
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
  /** The records this stage was shown. Empty for a stage that reads only pages. */
  parents: MemoryRecord[],
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

  /*
   * Three grounding states, not two.
   *
   * A record with a citation stands on its own and keeps the confidence the
   * model gave it. A record with no citation but with parents is *derived*: it
   * was compiled from records that are themselves grounded, which is how a
   * shared strategy layer is supposed to work. Capping those at 0.4 alongside
   * genuine inventions said the memory was far less grounded than it was, and
   * it flattened the distinction the whole design rests on.
   *
   * A derived record is capped at the least confident thing it rests on. It
   * cannot be more certain than its own foundation, and the rule needs no
   * chosen constant — the number comes from the graph.
   *
   * Only a record with neither a citation nor a parent is ungrounded, and that
   * is what the 0.4 cap and the red warning are for.
   */
  const parentFloor =
    parents.length > 0 ? Math.min(...parents.map((p) => p.confidence)) : null;

  const confidence =
    citations.length > 0
      ? emitted.confidence
      : parentFloor !== null
        ? Math.min(emitted.confidence, parentFloor)
        : Math.min(emitted.confidence, 0.4);

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
    totalUngrounded: 0,
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
      const header = `Company: ${workspace.name} (${workspace.domain})
Locales in this workspace: ${workspace.locales.join(", ")}${localeNote}

=== PREVIOUSLY COMPILED RECORDS ===
`;

      const fitted = fitPrompt(
        {
          priors: renderPriorRecords(dependencies),
          sources: stage.needsSources ? sourceBlock : "",
          search: searchBlock,
          fixed: header + keyNote + systemPromptFor(stage),
        },
        STAGE_MAX_TOKENS,
      );
      if (fitted.note) log(`  ${fitted.note}`);

      const sourcesSection = stage.needsSources
        ? `\n\n=== SOURCES ===\n${fitted.sources}`
        : `\n\n(Raw page text is not supplied to this stage. Ground records in the compiled records above; cite a source index only if the record above names one.)`;

      const userContent = `${header}${fitted.priors}${keyNote}${sourcesSection}${fitted.search}`;

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
            derived: 0,
            ungrounded: 0,
            superseded: 0,
            attempts: 2,
            skipped: e.message,
          });
          continue;
        }
        throw e;
      }

      let sourced = 0;
      let derived = 0;
      let ungrounded = 0;
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
          dependencies,
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
        else if (dependencyIds.length > 0) derived++;
        else ungrounded++;
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
        derived,
        ungrounded,
        superseded: supersededCount,
        attempts,
        ...(stage.runsResearch ? { searches, cachedSearches } : {}),
      });
      summary.totalRecords += emitted.length;
      summary.totalUngrounded += ungrounded;

      log(
        `stage ${label}: ${emitted.length} record(s), ${sourced} sourced, ${derived} derived, ${ungrounded} ungrounded, ${supersededCount} superseded, ${edges} derivation edge(s)`,
      );
    }
  }

  log(
    `compile done: ${summary.totalRecords} record(s), ${summary.totalUngrounded} ungrounded, ${failures.length} stage(s) failed`,
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
