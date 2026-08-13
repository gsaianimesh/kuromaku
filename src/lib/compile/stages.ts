import "server-only";
import { z } from "zod";
import type { MemoryType } from "../db/schema";

/**
 * The compiler chain from SPEC 7.2, in the order the spec gives: product facts,
 * ICP segments, positioning, messaging pillars, objections, competitors (this
 * stage runs research), channel priorities, roadmap items, voice rules per
 * locale.
 *
 * Each stage emits records in one shape. Provenance is enforced after the
 * model returns — see compile/index.ts — rather than trusted from the model.
 */

/**
 * Deliberately lenient about shape, strict about meaning. Models routinely
 * return "0" for an index or a bare value where a list was asked for; rejecting
 * those costs a retry and changes nothing about the content. What is *not*
 * coerced is provenance — an index still has to resolve to a real source, and
 * that check lives in compile/index.ts where the sources are known.
 */
const numberish = z.union([
  z.number(),
  z.string().transform((s) => Number(s)),
]);

/** Accepts a list, a single value, or a missing field. */
function listOf<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]),
    z.array(inner),
  );
}

const ENVELOPE_KEYS = new Set([
  "key",
  "value",
  "confidence",
  "sourceIndices",
  "source_indices",
  "sourceUrls",
  "source_urls",
  "snippet",
]);

/**
 * Normalises the two shapes models actually return. Asked for
 * `{key, value: {...}, confidence}`, they about as often return the payload
 * flattened onto the record itself, and snake_case for the source fields.
 * Both carry the same information, so both are accepted rather than spent on
 * a retry.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Fields that reasonably name a record, in preference order. */
const KEY_CANDIDATES = [
  "key",
  "id",
  "slug",
  "channel",
  "name",
  "title",
  "segment",
  "pillar",
  "rule",
  "objection",
  "fact",
  "statement",
];

const normaliseEnvelope = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;

  const out: Record<string, unknown> = {
    sourceIndices: obj.sourceIndices ?? obj.source_indices,
    sourceUrls: obj.sourceUrls ?? obj.source_urls,
    snippet: obj.snippet,
  };

  if (obj.value !== undefined && obj.value !== null) {
    out.value = obj.value;
  } else {
    // Flattened form: everything that is not envelope metadata is the payload.
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!ENVELOPE_KEYS.has(k)) payload[k] = v;
    }
    out.value = payload;
  }

  // A missing key is recoverable: the payload almost always names the record.
  // Deriving it beats spending a retry, and the key only has to be stable
  // within its type for superseding to work.
  if (typeof obj.key === "string" && obj.key.trim()) {
    out.key = slugify(obj.key);
  } else {
    const payload = (out.value ?? {}) as Record<string, unknown>;
    const named =
      KEY_CANDIDATES.map((c) => payload[c]).find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      ) ??
      // Last resort: any string field at all. A derived key is still stable
      // across re-compiles for the same content, which is all superseding
      // needs — and it beats discarding an otherwise usable record.
      Object.values(payload).find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
    if (named) out.key = slugify(named);
  }

  /*
   * A model that omits confidence has told us nothing about how sure it is, so
   * 0.5 records exactly that — neither trusted nor dismissed. It is not a
   * fabricated measurement: an unsourced record is still capped below 0.5 when
   * it is written, so nothing unsourced can present as confident.
   */
  out.confidence = obj.confidence ?? 0.5;

  return out;
};

export const emittedRecord = z.preprocess(normaliseEnvelope, z.object({
  /** Stable identifier within its type, used to supersede on re-compile. */
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("short kebab-case identifier, stable across re-compiles"),
  value: z.record(z.string(), z.unknown()),
  confidence: numberish.pipe(z.number().min(0).max(1)),
  /** Indices into the numbered source list given in the prompt. */
  sourceIndices: listOf(numberish.pipe(z.number().int().min(0))).default([]),
  /** URLs from the search results given in the prompt. */
  sourceUrls: listOf(z.string()).default([]),
  /** Verbatim supporting text, shown next to the fact in the memory viewer. */
  snippet: z.string().max(600).optional(),
}));

export type EmittedRecord = z.infer<typeof emittedRecord>;

/** Accepts `{records: [...]}` or a bare array, which models also return. */
export const stageOutput = z.preprocess(
  (v) => (Array.isArray(v) ? { records: v } : v),
  z.object({ records: z.array(emittedRecord).max(40) }),
);

export type StageId =
  | "product_facts"
  | "icp_segments"
  | "positioning"
  | "messaging_pillars"
  | "objections"
  | "competitors"
  | "channel_priorities"
  | "roadmap_items"
  | "voice_rules";

export type Stage = {
  id: StageId;
  memoryType: MemoryType;
  label: string;
  /** Instruction describing the shape of `value` and what counts as sourced. */
  instruction: string;
  /** Stages that must be compiled first; their records are given as context. */
  dependsOn: StageId[];
  /** True for the stage that runs web research (SPEC 7.2: competitors). */
  runsResearch?: boolean;
  /** True for the stage that runs once per workspace locale. */
  perLocale?: boolean;
  /**
   * Whether raw page text is sent to this stage. Only the stages that read the
   * company's own words need it — the rest reason from records already
   * compiled, which is the point of a shared strategy layer and keeps each
   * prompt inside the provider's per-minute token budget.
   */
  needsSources?: boolean;
};

const COMMON = `
You are compiling a marketing memory from a company's own website.

Rules that matter more than completeness:
- Every record must be grounded in the supplied material. Cite the numbered
  sources you used in "sourceIndices", and any supplied search-result URLs in
  "sourceUrls".
- If you believe something is true but cannot ground it in the supplied
  material, still emit it, set "confidence" below 0.5, and leave the source
  arrays empty. Do not invent a source. Do not silently drop the record.
- "confidence" is your honest read: 0.9+ when the material states it plainly,
  0.6-0.8 when it is a fair reading, below 0.5 when it is inference.
- "snippet" must be text that actually appears in the cited source.
- Never invent metrics, customer counts, funding, or performance numbers.

Return a single JSON object: {"records": [...]}.
`.trim();

export const STAGES: Stage[] = [
  {
    id: "product_facts",
    needsSources: true,
    memoryType: "product_fact",
    label: "Product facts",
    dependsOn: [],
    instruction: `Extract concrete, checkable facts about what the product is and does.
value: { "fact": string, "category": "capability" | "platform" | "pricing" | "privacy" | "integration" | "other" }
key: kebab-case summary of the fact, e.g. "local-first-storage".
Prefer specifics over adjectives. "Runs on macOS" is a fact; "beautifully designed" is not.`,
  },
  {
    id: "icp_segments",
    needsSources: true,
    memoryType: "icp_segment",
    label: "ICP segments",
    dependsOn: ["product_facts"],
    instruction: `Identify the ideal customer profiles the site is written for.
value: { "segment": string, "description": string, "painPoints": string[], "whereTheyGather": string[] }
key: kebab-case segment name, e.g. "solo-founders".
"whereTheyGather" should name real communities or platforms only if the material supports it.`,
  },
  {
    id: "positioning",
    memoryType: "positioning",
    label: "Positioning",
    dependsOn: ["product_facts", "icp_segments"],
    instruction: `State how the product positions itself against the alternatives.
value: { "statement": string, "category": string, "againstAlternative": string, "differentiator": string }
key: kebab-case, e.g. "private-local-memory-vs-cloud-assistants".
Emit at most 3 records.`,
  },
  {
    id: "messaging_pillars",
    memoryType: "messaging_pillar",
    label: "Messaging pillars",
    dependsOn: ["positioning", "product_facts"],
    instruction: `The recurring themes the company leads with.
value: { "pillar": string, "proofPoints": string[], "whyItMatters": string }
key: kebab-case pillar name. Emit 3 to 5 records.
Every proof point must be traceable to a product fact or the source text.`,
  },
  {
    id: "objections",
    memoryType: "objection",
    label: "Objections",
    dependsOn: ["icp_segments", "positioning"],
    instruction: `Objections a sceptical buyer in the ICP would raise.
value: { "objection": string, "response": string, "severity": "high" | "medium" | "low" }
key: kebab-case, e.g. "another-subscription".
An objection grounded in the ICP's stated pain points is sourced; a generic SaaS objection is not — mark those low confidence.`,
  },
  {
    id: "competitors",
    memoryType: "competitor",
    label: "Competitors",
    dependsOn: ["positioning", "product_facts"],
    runsResearch: true,
    instruction: `Competitors and alternatives, using the search results provided.
value: { "name": string, "url": string, "positioning": string, "overlap": string, "differenceFromUs": string }
key: kebab-case competitor name.
Only emit a competitor you can point at — either the site names it, or a search
result does. Cite the search-result URL in "sourceUrls". If research returned
nothing, emit competitors the site itself names and mark anything else low
confidence with no sources rather than listing plausible-sounding products.`,
  },
  {
    id: "channel_priorities",
    memoryType: "channel_priority",
    label: "Channel priorities",
    dependsOn: ["icp_segments", "positioning"],
    instruction: `Rank the marketing channels by fit for this ICP.
value: { "channel": string, "rank": number, "rationale": string, "effort": "low" | "medium" | "high" }
key: lowercase channel slug — use exactly these where they apply:
"x", "hacker_news", "product_hunt", "indie_communities", "reddit", "seo",
"content", "linkedin", "email", "youtube".
rank starts at 1 for the highest priority and must be unique.
Rank on evidence about where this ICP actually gathers, not on generic advice.
Emit 4 to 7 records.`,
  },
  {
    id: "roadmap_items",
    memoryType: "roadmap_item",
    label: "Roadmap items",
    dependsOn: ["channel_priorities", "messaging_pillars"],
    instruction: `Concrete marketing actions for the next 30 days.
value: { "title": string, "description": string, "channel": string, "horizonDays": number, "successLooksLike": string }
key: kebab-case action name.
"channel" must be one of the channel slugs from the channel priorities.
Each item must be something a person could start this week and finish. These
become executable jobs, so vague items like "build brand awareness" are useless.
Emit 4 to 8 records.`,
  },
  {
    id: "voice_rules",
    memoryType: "voice_rule",
    label: "Voice rules",
    dependsOn: ["messaging_pillars", "positioning"],
    perLocale: true,
    needsSources: true,
    instruction: `Rules describing how this company writes, for the given locale.
value: { "rule": string, "doExample": string, "dontExample": string }
key: kebab-case rule name, e.g. "no-hype-adjectives".
Derive rules only from source material actually written in this locale.
If none of the supplied sources are in this locale, say so: emit rules with
confidence below 0.4, no sources, and set value.rule to describe the gap
rather than translating rules observed in another language. Never present a
translated rule as an observed one.
Emit 3 to 6 records.`,
  },
];

export function stageById(id: StageId): Stage {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown compile stage: ${id}`);
  return s;
}

export function systemPromptFor(stage: Stage): string {
  return `${COMMON}\n\nStage: ${stage.label}\n${stage.instruction}`;
}
