import "server-only";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

/**
 * HTML to readable text and title (SPEC 7.1).
 *
 * Deliberately heuristic rather than a full readability port: strip the
 * furniture, prefer a main content element when the page marks one, and fall
 * back to the body. The compiler downstream reads this text, so losing a nav
 * label matters far less than dragging in a cookie banner on every page.
 */

const STRIP = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "template",
  "nav",
  "header",
  "footer",
  "form",
  "[aria-hidden='true']",
  "[hidden]",
];

/** Tried in order; the first match with meaningful text wins. */
const MAIN_CANDIDATES = [
  "main",
  "article",
  "[role='main']",
  "#main",
  "#content",
  ".content",
  ".post",
  ".prose",
];

export type Extracted = {
  title: string | null;
  description: string | null;
  text: string;
  links: string[];
  contentHash: string;
};

export function extract(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);

  // Collect links before stripping navigation, or the crawl frontier empties.
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absolutise(href, pageUrl);
    if (abs) links.add(abs);
  });

  const title =
    clean($("meta[property='og:title']").attr("content")) ??
    clean($("title").first().text()) ??
    clean($("h1").first().text());

  const description =
    clean($("meta[name='description']").attr("content")) ??
    clean($("meta[property='og:description']").attr("content"));

  $(STRIP.join(",")).remove();

  let text = "";
  for (const sel of MAIN_CANDIDATES) {
    const node = $(sel).first();
    if (node.length) {
      const candidate = normaliseText(node.text());
      // A "main" that holds almost nothing usually means the real content sits
      // elsewhere, so keep looking rather than trusting the tag.
      if (candidate.length > 200) {
        text = candidate;
        break;
      }
    }
  }
  if (!text) text = normaliseText($("body").text());

  return {
    title,
    description,
    text,
    links: [...links],
    // Hash the extracted text, not the raw HTML: a changed build id or a
    // rotating CSRF token in the markup should not read as changed content.
    contentHash: hashContent(text, title),
  };
}

export function hashContent(text: string, title?: string | null): string {
  return createHash("sha256")
    .update(`${title ?? ""}\n${text}`)
    .digest("hex");
}

/** Extract URLs from a sitemap or sitemap index. */
export function extractSitemapUrls(xml: string): {
  pages: string[];
  sitemaps: string[];
} {
  const $ = cheerio.load(xml, { xmlMode: true });
  const pages: string[] = [];
  const sitemaps: string[] = [];

  $("sitemapindex > sitemap > loc").each((_, el) => {
    const v = clean($(el).text());
    if (v) sitemaps.push(v);
  });
  $("urlset > url > loc").each((_, el) => {
    const v = clean($(el).text());
    if (v) pages.push(v);
  });

  return { pages, sitemaps };
}

function clean(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function normaliseText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    // Collapse runs of blank lines, but keep paragraph breaks: the compiler
    // reads this and structure carries meaning.
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

function absolutise(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Fragments are the same document.
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
