# Five-minute walkthrough

The point of this script is to show the five things that make this different from
the tool it rebuilds. Each step names the defect it answers.

**Before you start:** `npm run dev`, then check `/health` is green.

On a free Groq tier a full compile takes roughly five minutes, most of it spent
waiting out an 8,000 tokens-per-minute limit. The waits are printed in the log as
they happen. Run the compile before the demo, not during it.

---

## 0. The state you want (2 min, do this beforehand)

```bash
npm run db:migrate
npm run dev
```

- `/sources` → **Queue crawl** → **Run crawl now**. Eight pages from
  shogunaios.com land with content hashes.
- `/memory` → **Queue compile** → **Run compile now**. Watch the stage log.

---

## 1. Provenance on every fact — 60s

Go to **`/memory`**.

Point at the header: *44 active · N unsourced · avg confidence*.

Scroll to **Product facts**. Every row shows its value, a confidence score, and
underneath it **the source it came from**, as a clickable link with the snippet.

Now find a row badged **unsourced** (there will be several, usually in Messaging
pillars or Channel priorities). Read the warning aloud:

> "No source. This record is not grounded in any crawled page or search result —
> treat it as an unverified inference."

**The defect this answers:** Okara asserted facts flat, with no source. It listed
integrations and a latency claim that were simply wrong, and every agent then
repeated them forever. Here an ungrounded claim cannot hide — it is capped below
0.5 confidence *by the writer, not the model*, and it is labelled.

Also worth showing: **Competitors** is empty or entirely unsourced. That is
because no search API key is configured. The system said so rather than
inventing five plausible competitor names.

---

## 2. Versioned memory with staleness propagation — 90s

This is the headline. Do it slowly.

Still on **`/memory`**, pick an **ICP segment** row and click **edit**. Change
the description — make the change obvious, e.g. add "SOLO FOUNDERS ONLY" to the
segment name. Click **Save new version**.

Read the confirmation:

> "Saved as a new version. N artifact(s) derived from the previous version are
> now marked stale."

Click **history** on that row. Both versions are there: v1 `superseded`
(origin `compiled`), v2 `active` (origin `human`). Nothing was overwritten.

Now go to **`/review`**. The drafts that cited that record carry a **stale**
banner naming exactly which record changed, and a **Regenerate from current
memory** button.

**The defect this answers:** editing the ICP in Okara left every derived draft
unchanged and unflagged. You could not tell which work was now based on a fact
you had just corrected.

---

## 3. The agent set is derived from the strategy — 60s

Go to **`/planner`** and click **Run planner now**.

Look at **Channel priorities vs agent coverage**. The left side is what the
strategy compiled. The right side is what can actually execute it.

Then look at **Coverage gaps** above it. Channels the strategy ranked highly but
that no registered agent serves are listed in red, with the rank and the reason.

Say the important part out loud:

> "The planner did not silently skip these. It recorded that the strategy asked
> for a channel nothing can execute, and it made someone look at it."

**The defect this answers:** Okara's own strategy ranked Product Hunt third and
founder communities fourth, and it had no agent for either — while shipping UGC
video and influencer agents its strategy never asked for. The catalogue was
fixed and unrelated to the plan.

Scroll to **Scheduled work**: every job carries the plain-language reason it was
scheduled.

---

## 4. Evidence, not justification — 60s

Go to **`/review`**.

Each draft shows the content, then an **Evidence** panel. Every item is a link:
memory record ids go to `/memory/<id>`, thread URLs go to the actual thread.
Click one — it lands on the record, with its own sources.

Next to it, the **Critic** panel: the score, and specific named violations. If
the draft scored below 0.7 it says so:

> "Scored below threshold and was revised once automatically before reaching you."

Under **Performance**: if nothing was measured, it says so in words rather than
showing zeros.

**The defect this answers:** Okara's drafts carried a prose "why this works"
panel with no links, no named threads, no data, and no way to tell which memory
record informed the choice. And it rendered *invented* like and view counts on
unpublished drafts.

Now edit a draft: **Edit and approve**, change a sentence, save. The confirmation
gives you the normalised edit distance. Go to **`/metrics`** — that edit is now a
point on the chart.

---

## 5. Performance closes the loop — 60s

Go to **`/publish`**.

Read the note at the top: no agent posts anywhere. For Hacker News and Reddit the
only supported flow is copy, post it yourself, confirm the URL.

Copy an approved draft, paste a URL into **I posted this**, submit. It moves to
**Published**.

Record an observation against it — `upvotes`, some number. Then go back to
**`/planner`** and run the planner again.

Now the payoff. Create the opposite condition: a channel with recent drafts and
*no* observations gets **skipped**, and the planner says why:

> "N artifact(s) in the last 14 days and no observations recorded for any of
> them. Record performance for this channel before drafting more."

**The defect this answers:** Okara's whole pipeline completed with Search Console
and Analytics skipped, and nothing degraded. Performance data was never an input
to planning.

---

## 6. If asked: cost and openness — 30s

**`/jobs`** → click any job → **inspect**. Every model call is there with its
prompt, model, token counts and cost. An unpriced model shows as *unpriced*, not
as `$0.00`.

Openness:

```bash
curl localhost:3000/api/v1/memory | jq '.records[0]'
curl localhost:3000/api/mcp | jq '.tools[].name'
```

Okara is closed — no API, no MCP. Being open is the point, and it matches what
ShogunAI itself is built on.

---

## The one-sentence version

> Okara compiles context once and then forgets. This remembers: every fact keeps
> its source, editing a fact invalidates everything derived from it, the plan is
> compared against what can actually execute it, and nothing shows a number that
> was not measured.
