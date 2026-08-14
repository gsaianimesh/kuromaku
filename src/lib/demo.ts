import "server-only";

/**
 * The public demo instance.
 *
 * This project has no authentication (see docs/15), which is fine for a local
 * operator and not fine for a URL printed in a document. The instance exists so
 * a reader can check the claims made about it, so it stays open — but "open"
 * has to stop short of letting an anonymous visitor spend the owner's model
 * credits or replace the owner's stored API key.
 *
 * `DEMO_MODE=1` refuses exactly those actions. Everything else — reading memory,
 * following provenance, editing a record and watching what goes stale,
 * approving a draft — still works, because those are the claims worth checking
 * and none of them costs anything.
 *
 * This is a stopgap with an honest name. It is not authentication and it does
 * not pretend to be: it is a per-action refusal list, and the real fix is the
 * auth work described in docs/15.
 */
export const DEMO_MODE = process.env.DEMO_MODE === "1";

export class DemoModeError extends Error {
  constructor(what: string) {
    super(
      `${what} is disabled on the public demo: it spends the owner's model credits. ` +
        `Clone the repository and run it locally to exercise this path.`,
    );
    this.name = "DemoModeError";
  }
}

/** Throws when the instance is a public demo. Call at the top of the action. */
export function refuseOnDemo(what: string): void {
  if (DEMO_MODE) throw new DemoModeError(what);
}

/**
 * Non-throwing variant for actions that report a result object rather than
 * surfacing an exception to an error boundary.
 */
export function demoRefusal(what: string): { ok: false; message: string } | null {
  if (!DEMO_MODE) return null;
  return { ok: false, message: new DemoModeError(what).message };
}
