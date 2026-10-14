// Renders the link-preview image (public/og-image.png, 1200x630) and the
// home-screen icon (public/apple-touch-icon.png, 180x180) from the brand
// mark. Re-run after changing the headline or the mark:
//
//   bun scripts/og-image.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mark = readFileSync(join(root, "public/gandalf-mark-bold-v2.svg"), "utf8");
const font = (file) =>
	readFileSync(join(root, "node_modules/@fontsource-variable", file)).toString("base64");

const fonts = `
  @font-face { font-family: Geist; font-weight: 100 900;
    src: url(data:font/woff2;base64,${font("geist/files/geist-latin-wght-normal.woff2")}); }
  @font-face { font-family: "Geist Mono"; font-weight: 100 900;
    src: url(data:font/woff2;base64,${font("geist-mono/files/geist-mono-latin-wght-normal.woff2")}); }`;

const card = `<!doctype html><style>${fonts}
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; padding: 72px 80px; background: #fafaf9; color: #0c0c0b;
    font-family: Geist, sans-serif; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
  .brand svg { width: 52px; height: 45px; }
  h1 { margin-top: 84px; max-width: 17ch; font-size: 76px; line-height: 1.02; letter-spacing: -0.04em; font-weight: 600; }
  .agents { margin-top: auto; display: flex; gap: 12px; font-family: "Geist Mono", monospace; font-size: 24px; }
  .agents span { padding: 10px 18px; border: 1px solid #d6d5d0; border-radius: 8px; background: #fff; }
  .agents .meta { margin-left: auto; border: 0; background: none; color: #6b6b67; padding-right: 0; }
  .dot { color: #ff5f6a; }
</style>
<div class="brand">${mark}<span>Gandalf</span></div>
<h1>Skills and work context across coding agents<span class="dot">.</span></h1>
<div class="agents"><span>Claude Code</span><span>Codex</span><span>Cursor</span><span class="meta">usegandalf.com</span></div>`;

const icon = `<!doctype html><style>
  * { margin: 0; } body { width: 180px; height: 180px; background: #fafaf9; display: grid; place-items: center; }
  svg { width: 124px; height: 108px; }
</style>${mark}`;

const browser = await chromium.launch();
for (const [html, width, height, file] of [
	[card, 1200, 630, "og-image.png"],
	[icon, 180, 180, "apple-touch-icon.png"],
]) {
	const page = await browser.newPage({ viewport: { width, height } });
	await page.setContent(html);
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: join(root, "public", file) });
	await page.close();
}
await browser.close();
