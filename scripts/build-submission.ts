/**
 * Builds submission/Kuromaku.html from submission/content.md plus the captured
 * screenshots, inlining every image as a base64 data URI so the file is
 * self-contained and prints to PDF without a network round trip.
 *
 *   npm run submission
 *
 * Images are referenced in the markdown as ![alt](shot:name). The builder
 * resolves `name` against docs/images/ and docs/images/pairs/, and **fails** if
 * a referenced shot does not exist, so the document cannot ship claiming a
 * screenshot it does not have.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONTENT = path.join(ROOT, "submission", "content.md");
const OUT = path.join(ROOT, "submission", "Kuromaku.html");
const IMAGE_DIRS = [
  path.join(ROOT, "docs", "images"),
  path.join(ROOT, "docs", "images", "pairs"),
];

/**
 * Screenshots of Okara, the product this one was built against. Unlike every
 * other image here these were not captured by a script in this repository —
 * they came from a first-hand session with someone else's product, and they are
 * the only evidence a reader has that section 2 describes something real.
 */
const EVIDENCE_DIR = path.join(ROOT, "submission", "evidence");

/**
 * Missing evidence normally fails the build, exactly like a missing screenshot.
 * `--allow-missing-evidence` omits the figure instead and says so on stderr,
 * for building the rest of the document before the images are dropped in. It
 * never substitutes anything.
 */
const ALLOW_MISSING_EVIDENCE = process.argv.includes("--allow-missing-evidence");

const missing: string[] = [];
const missingEvidence: string[] = [];
let embeddedBytes = 0;

/*
 * Newest match wins. A shot re-captured in the other format used to be
 * shadowed by the stale original because the extension order was fixed, and
 * the document silently shipped the old image.
 */
async function resolveShot(name: string): Promise<string | null> {
  let best: { file: string; mtime: number } | null = null;
  for (const dir of IMAGE_DIRS) {
    for (const ext of [".png", ".jpg"]) {
      const p = path.join(dir, name + ext);
      try {
        const s = await stat(p);
        if (!best || s.mtimeMs > best.mtime) best = { file: p, mtime: s.mtimeMs };
      } catch {
        /* keep looking */
      }
    }
  }
  return best?.file ?? null;
}

async function resolveEvidence(name: string): Promise<string | null> {
  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const p = path.join(EVIDENCE_DIR, name + ext);
    try {
      await stat(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function dataUri(file: string): Promise<string> {
  const buf = await readFile(file);
  embeddedBytes += buf.length;
  const mime = file.endsWith(".jpg") ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Minimal markdown: headings, paragraphs, lists, code, images, emphasis. */
function inline(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
}

async function render(md: string): Promise<string> {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      closeList();
      const escaped = body
        .join("\n")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      out.push(`<pre class="code" data-lang="${lang}"><code>${escaped}</code></pre>`);
      continue;
    }

    // Page break marker
    if (line.trim() === "<!--page-->") {
      closeList();
      out.push('<div class="page-break"></div>');
      i++;
      continue;
    }

    /*
     * Link block: :::links … :::
     * Each line is its own row. Without this the paragraph rule joined them
     * into one run-on line, which is how the live URL ended up mid-sentence.
     */
    if (line.trim() === ":::links") {
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ":::") body.push(lines[i++]);
      i++;
      const rows = body
        .filter((l) => l.trim() !== "")
        .map((l) => `<div>${inline(l.trim())}</div>`)
        .join("\n");
      out.push(`<div class="links">${rows}</div>`);
      continue;
    }

    // Image pair block: :::pair
    if (line.trim().startsWith(":::pair")) {
      closeList();
      const label = line.trim().slice(7).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(":::")) body.push(lines[i++]);
      i++;
      out.push(`<figure class="pair">`);
      if (label) out.push(`<div class="pair-title">${inline(label)}</div>`);
      out.push(await render(body.join("\n")));
      out.push(`</figure>`);
      continue;
    }

    // Image: ![alt](shot:name) from the capture scripts, or ![alt](evidence:name)
    // from submission/evidence — screenshots of the product this one answers.
    const img = line.match(
      /^!\[([^\]]*)\]\((shot|evidence):([a-z0-9-]+)\)(?:\{(before|after)\})?\s*$/i,
    );
    if (img) {
      closeList();
      const [, alt, kind, name, side] = img;
      const isEvidence = kind.toLowerCase() === "evidence";
      const file = isEvidence ? await resolveEvidence(name) : await resolveShot(name);
      if (!file) {
        if (isEvidence) {
          missingEvidence.push(name);
          if (!ALLOW_MISSING_EVIDENCE) {
            i++;
            continue;
          }
          // Skip the figure *and* its caption, so no caption is left orphaned
          // describing an image that is not there.
          i++;
          while (i < lines.length && lines[i].trim() === "") i++;
          if (i < lines.length && /^:\s/.test(lines[i])) {
            while (i < lines.length && lines[i].trim() !== "") i++;
          }
          continue;
        }
        missing.push(name);
        i++;
        continue;
      }
      const uri = await dataUri(file);
      const badge = side
        ? `<div class="shot-badge ${side.toLowerCase()}">${side.toLowerCase()}</div>`
        : "";

      /*
       * A caption is an explicit `: ` line following the image. The old rule
       * took any following paragraph beginning "Note", which quietly made the
       * word load-bearing: rewording a caption to open differently detached it
       * from its image and turned it into body text.
       */
      let caption = "";
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const isCaption =
        j < lines.length && (/^:\s/.test(lines[j]) || /^Note\b/i.test(lines[j].trim()));
      if (isCaption) {
        const capLines: string[] = [];
        while (j < lines.length && lines[j].trim() !== "") capLines.push(lines[j++]);
        caption = capLines.join(" ").trim().replace(/^:\s*/, "");
        i = j;
      } else {
        i++;
      }
      out.push(
        `<figure class="shot${isEvidence ? " evidence" : ""}">${badge}` +
          `<img src="${uri}" alt="${alt.replace(/"/g, "&quot;")}" />` +
          (caption ? `<figcaption>${inline(caption)}</figcaption>` : "") +
          `</figure>`,
      );
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = inline(h[2]);
      const id = h[2]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    // Bullets
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // Blank
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // Callout
    if (line.startsWith("> ")) {
      closeList();
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) body.push(lines[i++].slice(2));
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    // Paragraph
    closeList();
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|```|\s*[-*]\s|> |---+\s*$|!\[|:::)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

const STYLE = `
:root {
  --navy: #16233d;
  --navy-soft: #2c3e63;
  --ink: #1c1f26;
  --ink-soft: #4a5162;
  --rule: #d7dce5;
  --bg: #ffffff;
  --code-bg: #f5f7fa;
  --accent: #8a6f3f;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Charter", "Iowan Old Style", Georgia, "Times New Roman", serif;
  font-size: 10.4pt;
  line-height: 1.52;
}
.sheet { max-width: 46em; margin: 0 auto; padding: 3.2em 3em 4em; }
h1, h2, h3, h4 {
  font-family: "Charter", "Iowan Old Style", Georgia, serif;
  color: var(--navy);
  font-weight: 600;
  line-height: 1.25;
  margin: 1.5em 0 0.45em;
  break-after: avoid;
}
h1 { font-size: 24pt; letter-spacing: -0.01em; margin-top: 0; }
h2 { font-size: 16pt; border-bottom: 1.5px solid var(--rule); padding-bottom: 0.28em; }
h3 { font-size: 12.4pt; }
h4 { font-size: 11pt; color: var(--navy-soft); }
p { margin: 0 0 0.7em; }
ul { margin: 0 0 0.8em; padding-left: 1.2em; }
li { margin-bottom: 0.22em; }
a { color: var(--navy-soft); text-decoration: underline; text-underline-offset: 2px; }
code {
  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 0.845em;
  background: var(--code-bg);
  padding: 0.1em 0.34em;
  border-radius: 3px;
}
pre.code {
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--navy-soft);
  border-radius: 4px;
  padding: 0.85em 1em;
  /*
   * Wrap rather than scroll. A horizontal scrollbar is invisible on paper, so
   * an over-long line was simply cut off in the PDF mid-sentence.
   */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 8.6pt;
  line-height: 1.5;
  margin: 0 0 1.1em;
  break-inside: avoid;
  page-break-inside: avoid;
}
pre.code code { background: none; padding: 0; font-size: inherit; }
blockquote {
  margin: 0 0 1em;
  padding: 0.7em 1.1em;
  background: #f7f5f0;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
  font-size: 0.95em;
}
hr { border: none; border-top: 1px solid var(--rule); margin: 2.2em 0; }
figure.shot {
  margin: 0.85em 0 1.05em;
  /*
   * An image and its caption are one unit. break-inside alone is honoured by
   * the modern engine; the legacy property is kept because print pipelines vary
   * and a caption printed under the next image is worse than a page break.
   */
  break-inside: avoid;
  page-break-inside: avoid;
  position: relative;
}
figure.shot img { break-after: avoid; page-break-after: avoid; }
figure.shot figcaption { break-before: avoid; page-break-before: avoid; }
figure.evidence img { border-color: var(--accent); }
figure.shot img {
  width: 100%;
  height: auto;
  margin: 0 auto;
  display: block;
  border: 1px solid var(--rule);
  border-radius: 4px;
}
figcaption {
  font-size: 9.2pt;
  color: var(--ink-soft);
  line-height: 1.5;
  margin-top: 0.5em;
  padding-left: 0.15em;
  font-style: italic;
}
/*
 * The badge sits above the shot rather than on it. Overlaying the top-left
 * corner covered the first row of whatever panel was captured, which on a
 * screenshot-led document means hiding the thing the caption points at.
 */
.shot-badge {
  display: inline-block;
  margin-bottom: 0.3em;
  font-family: "SF Mono", Menlo, monospace;
  font-style: normal;
  font-size: 7.6pt;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  padding: 0.22em 0.62em;
  border-radius: 3px;
  color: #fff;
}
.shot-badge.before { background: #6b7280; }
.shot-badge.after { background: var(--navy); }
figure.pair {
  margin: 1.05em 0 1.35em;
  padding: 0.8em 0.9em 0.4em;
  border: 1px solid var(--rule);
  border-radius: 5px;
  background: #fbfcfd;
  /*
   * A pair is one unit and does not split. Letting the frame break saved a few
   * pages and produced the worst artefact in the document: three pairs printed
   * as a title above an empty bordered box, with the images they introduce on
   * the following page. A before/after the reader has to turn a page to compare
   * is not a before/after.
   */
  break-inside: avoid;
  page-break-inside: avoid;
}
figure.pair > figure.shot { break-inside: avoid; page-break-inside: avoid; }
.pair-title {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 8.4pt;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--navy-soft);
  margin-bottom: 0.9em;
}
.page-break { break-after: page; }
.masthead {
  border-bottom: 2.5px solid var(--navy);
  padding-bottom: 1.4em;
  margin-bottom: 2em;
}
.masthead .sub {
  font-size: 11.5pt;
  color: var(--ink-soft);
  margin-top: 0.4em;
}
.links {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 8.8pt;
  margin: 1.1em 0 1.6em;
  padding: 0.75em 1em;
  line-height: 1.9;
  border-top: 1.5px solid var(--navy);
  border-bottom: 1px solid var(--rule);
  background: #fafbfc;
}
.links a { font-weight: 600; }
@page { size: A4; margin: 15mm 14mm 16mm; }
@media print {
  .sheet { max-width: none; padding: 0; }
  a { color: var(--navy-soft); }
  /*
   * No forced breaks anywhere. Twenty-nine figures all carry break-inside:
   * avoid, so the layout already jumps often; adding a page break per section
   * on top of that was buying three more pages of white for no reading gain.
   * The rules that remain only stop a heading or a caption being orphaned.
   */
  h2, h3, h4 { break-after: avoid; break-inside: avoid; }
  figcaption { break-before: avoid; }
}
`;

async function main() {
  const md = await readFile(CONTENT, "utf8");
  const body = await render(md);

  if (missing.length > 0) {
    console.error("\nMissing screenshots referenced by the document:\n");
    for (const m of [...new Set(missing)]) console.error(`  - shot:${m}`);
    console.error(
      "\nCapture them (npm run screenshots / npm run pairs) rather than removing the reference.",
    );
    process.exit(1);
  }

  if (missingEvidence.length > 0) {
    const names = [...new Set(missingEvidence)];
    console.error(
      `\n${ALLOW_MISSING_EVIDENCE ? "OMITTED" : "Missing"} Okara evidence image(s):\n`,
    );
    for (const m of names) {
      console.error(`  - submission/evidence/${m}.{png,jpg,jpeg,webp}`);
    }
    if (!ALLOW_MISSING_EVIDENCE) {
      console.error(
        "\nSection 2 asserts nine defects in a product the reader has never seen; these" +
          "\nscreenshots are the evidence. Drop them in, or pass --allow-missing-evidence" +
          "\nto build without them and ship a document that only asserts.",
      );
      process.exit(1);
    }
    console.error(
      "\nBuilt without them. The figures and their captions were omitted, not substituted.",
    );
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kuromaku</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
${body}
</main>
</body>
</html>`;

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, html, "utf8");

  const kb = Math.round((await stat(OUT)).size / 1024);
  console.log(`submission/Kuromaku.html  ${kb} KB`);
  console.log(`  images embedded: ${Math.round(embeddedBytes / 1024)} KB raw`);
  if (kb > 12_000) {
    console.warn("  WARNING: over 12 MB. Consider tighter JPEG quality.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
