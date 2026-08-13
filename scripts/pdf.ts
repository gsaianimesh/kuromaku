/**
 * Renders submission/Kuromaku.html to submission/Kuromaku.pdf.
 *
 *   npm run pdf
 *
 * The HTML is fully self-contained, so this needs no server and no network.
 * Print margins come from the document's own @page rule; passing zero here
 * lets that rule win rather than stacking two sets of margins.
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";

const HTML = resolve("submission/Kuromaku.html");
const PDF = resolve("submission/Kuromaku.pdf");

async function main() {
  await stat(HTML).catch(() => {
    console.error("submission/Kuromaku.html is missing. Run `npm run submission` first.");
    process.exit(1);
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(HTML).href, {
    waitUntil: "networkidle",
    timeout: 180_000,
  });

  // Every image is a data URI, but decoding twenty-four of them is not instant
  // and a shot still decoding prints as a blank box.
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll("img")];
    await Promise.all(
      imgs.map((i) =>
        i.complete ? null : new Promise((r) => i.addEventListener("load", r, { once: true })),
      ),
    );
  });
  await page.waitForTimeout(600);

  const broken = await page.evaluate(
    () => [...document.querySelectorAll("img")].filter((i) => !i.naturalWidth).length,
  );
  if (broken > 0) {
    console.error(`${broken} image(s) failed to decode. Refusing to write a PDF with gaps.`);
    process.exit(1);
  }

  await page.pdf({
    path: PDF,
    format: "A4",
    printBackground: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  await browser.close();

  const { size } = await stat(PDF);
  console.log(`submission/Kuromaku.pdf  ${(size / 1048576).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
