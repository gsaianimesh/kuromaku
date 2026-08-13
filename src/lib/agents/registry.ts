import "server-only";
import type { MemoryType } from "../db/schema";

/**
 * The agent registry, seeded in code rather than the database (SPEC section 6).
 *
 * This list is deliberately shorter than the channel list the compiler can
 * produce. That mismatch is the point: a prioritised channel with no agent here
 * becomes a visible coverage gap instead of silently doing nothing, which is
 * the single most important behavioural difference from Okara (SPEC section 3).
 */

export type AgentDefinition = {
  id: string;
  /** Channel slugs this agent can serve — must match channel_priority keys. */
  channels: string[];
  displayName: string;
  description: string;
  capabilities: string[];
  requiredMemory: MemoryType[];
  /** Rough USD per run, for the planner and the jobs UI. Not a measurement. */
  estimatedCostUsd: number;
};

export const AGENTS: AgentDefinition[] = [
  {
    id: "launch_community",
    channels: ["x", "hacker_news", "product_hunt", "indie_communities"],
    displayName: "Launch and community agent",
    description:
      "Finds real discussions, evaluates fit against the ICP, and drafts a post or comment angle with the thread URL as evidence.",
    capabilities: ["discussion_search", "post_draft", "comment_angle"],
    requiredMemory: [
      "icp_segment",
      "positioning",
      "messaging_pillar",
      "voice_rule",
      "product_fact",
    ],
    estimatedCostUsd: 0.02,
  },
  {
    id: "content",
    channels: ["content", "seo"],
    displayName: "Content agent",
    description:
      "Drafts long-form and comparison pages from the compiled memory, citing the records and competitors it used.",
    capabilities: ["long_form", "comparison_page"],
    requiredMemory: [
      "positioning",
      "messaging_pillar",
      "objection",
      "competitor",
      "voice_rule",
    ],
    estimatedCostUsd: 0.05,
  },
];

export function agentById(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Every agent that can serve a channel. Empty means a coverage gap. */
export function agentsForChannel(channel: string): AgentDefinition[] {
  return AGENTS.filter((a) => a.channels.includes(channel));
}

export function coveredChannels(): Set<string> {
  return new Set(AGENTS.flatMap((a) => a.channels));
}
