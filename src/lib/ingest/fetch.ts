import "server-only";

/**
 * Polite HTTP for the crawler. One place that owns the user agent, timeouts
 * and size caps, so no other module can quietly fetch without them.
 */

export const USER_AGENT =
  "KuromakuBot/0.1 (+https://github.com/gsaianimesh/kuromaku)";

/** Refuse to read more than this from any single URL. */
const MAX_BYTES = 2_000_000;

export type FetchResult =
  | {
      ok: true;
      status: number;
      url: string;
      contentType: string;
      body: string;
      bytes: number;
    }
  | { ok: false; status: number | null; url: string; error: string };

export async function politeFetch(
  url: string,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: opts.accept ?? "text/html,application/xhtml+xml",
        "accept-language": "en",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        url,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    // Reject obviously non-textual payloads before reading the body.
    if (contentType && !/text\/|xml|json|html/i.test(contentType)) {
      return {
        ok: false,
        status: res.status,
        url,
        error: `Skipped non-text content type: ${contentType}`,
      };
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      return {
        ok: false,
        status: res.status,
        url,
        error: `Skipped: ${declared} bytes exceeds the ${MAX_BYTES} byte cap`,
      };
    }

    const body = await res.text();
    if (body.length > MAX_BYTES) {
      return {
        ok: false,
        status: res.status,
        url,
        error: `Skipped: body exceeds the ${MAX_BYTES} byte cap`,
      };
    }

    return {
      ok: true,
      status: res.status,
      // res.url reflects redirects, which is the URL we actually read.
      url: res.url || url,
      contentType,
      body,
      bytes: body.length,
    };
  } catch (e) {
    const error =
      e instanceof Error
        ? e.name === "TimeoutError"
          ? `Timed out after ${timeoutMs}ms`
          : e.message
        : String(e);
    return { ok: false, status: null, url, error };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
