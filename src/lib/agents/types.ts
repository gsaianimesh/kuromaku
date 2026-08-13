import "server-only";
import type { Job, MemoryType } from "../db/schema";
import type { RecordWithSources } from "../memory";
import type { SearchOutcome } from "../search";

/**
 * The agent contract from SPEC 7.5. One interface, several implementations —
 * the runner must not need changing to add an agent, which is the thing Phase 8
 * checks.
 */

export type MemorySlice = {
  /** Active records grouped by type, already filtered to what the agent asked for. */
  byType: Partial<Record<MemoryType, RecordWithSources[]>>;
  all: RecordWithSources[];
  locale: string;
};

export type EvidenceItem = {
  /** A memory record this draft was derived from. Drives staleness (SPEC 7.3). */
  memoryRecordId?: string;
  /** A link the draft rests on — a real thread, a real page. */
  sourceUrl?: string;
  /** Observed data points only. Never a projection. */
  data?: Record<string, unknown>;
  note: string;
};

export type AgentTools = {
  /** Cached, deduplicated web search. Returns an unavailable reason, never fake results. */
  search: (query: string) => Promise<SearchOutcome>;
  /** A model call, logged to agent_runs with cost. */
  complete: (input: {
    task: "draft" | "classify" | "critique";
    system: string;
    user: string;
    maxTokens?: number;
  }) => Promise<string>;
  /** Structured model call with Zod validation and one retry. */
  completeJson: <T>(
    input: {
      task: "draft" | "classify" | "critique";
      system: string;
      user: string;
      maxTokens?: number;
    },
    schema: import("zod").ZodType<T>,
  ) => Promise<T>;
  log: (message: string) => void;
};

export type DraftedArtifact = {
  kind: string;
  channel: string;
  content: string;
  locale: string;
  /** SPEC 7.5: at least one item, or the artifact fails validation. */
  evidence: EvidenceItem[];
};

export interface ChannelAgent {
  id: string;
  channel: string;
  requiredMemory: MemoryType[];
  run(input: {
    job: Job;
    memory: MemorySlice;
    tools: AgentTools;
  }): Promise<{ artifacts: DraftedArtifact[] }>;
}
