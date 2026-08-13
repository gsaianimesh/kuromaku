import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { eq } from "drizzle-orm";
import { getDb } from "./src/lib/db";
import { artifacts, jobs } from "./src/lib/db/schema";
import { enqueue } from "./src/lib/jobs/queue";
import { runWorker } from "./src/lib/jobs/worker";
import { editDistanceSeries } from "./src/lib/review";
import { reviewArtifact } from "./src/lib/review";
import { getOrCreateDefaultWorkspace } from "./src/lib/workspace";

const ws = await getOrCreateDefaultWorkspace();
const db = getDb();

// A genuine human edit on the content-agent draft: tighten the heading the
// critic flagged as an exaggerated adjective. This is the review action the
// edit-distance metric exists to measure.
const [content] = await db.select().from(artifacts).where(eq(artifacts.status, "draft"));
if (content) {
  const edited = content.content
    .replace(/Revolutionizing/gi, "Rethinking")
    .replace(/unique approach/gi, "approach")
    .replace(/game-?changer/gi, "useful");
  const { editDistance } = await reviewArtifact({
    artifactId: content.id, decision: "edit", editedContent: edited });
  console.log(`edited ${content.id.slice(0,8)} (${content.agentId}) -> distance ${editDistance?.toFixed(4)}`);
}

// Fresh draft so the review queue has real pending work with a critic score.
await db.delete(jobs).where(eq(jobs.type, "run_agent"));
await enqueue({ workspaceId: ws.id, type: "run_agent",
  idempotencyKey: `docs:${Date.now()}`,
  payload: { agentId: "launch_community", channel: "hacker_news", locale: "en" },
  reason: "Channel ranked 1 in the compiled strategy. Launch and community agent covers it.",
  maxAttempts: 1 });
const res = await runWorker({ maxJobs: 1, budgetMs: 600_000 });
console.log("agent:", res.processed[0]?.outcome, res.processed[0]?.error?.slice(0,150) ?? "");

const series = await editDistanceSeries(ws.id);
console.log("\nedit-distance series:", JSON.stringify(series));
const final = await db.select().from(artifacts).where(eq(artifacts.workspaceId, ws.id));
console.log("artifacts:", final.map(a=>`${a.status}:${a.channel}(critic ${a.criticScore})`).join(", "));
