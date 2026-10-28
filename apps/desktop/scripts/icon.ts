import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const LOGO_SVG = fileURLToPath(
  new URL("../../landing/public/gandalf-logo.svg", import.meta.url),
);
export const ICON_ICNS = fileURLToPath(new URL("../build/icon.icns", import.meta.url));

const run = promisify(execFile);

/** Every image an iconset holds: each point size at 1x and 2x. */
export const ICONSET = [16, 32, 128, 256, 512].flatMap((points) => [
  { name: `icon_${points}x${points}.png`, pixels: points },
  { name: `icon_${points}x${points}@2x.png`, pixels: points * 2 },
]);

const CANVAS = 1024;
// macOS's app icon grid: an 824 pt rounded square inset 100 pt in a 1024 pt canvas.
const INSET = 100;
const BODY = 824;
const CORNER = 185;

/** The light mode logo on a white rounded square, on the macOS icon grid. */
export function iconSvg(logo: string): string {
  const viewBox = /viewBox="0 0 (\d+(?:\.\d+)?) \d+(?:\.\d+)?"/.exec(logo);
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(logo);
  if (viewBox?.[1] === undefined || inner?.[1] === undefined) {
    throw new Error("the logo is not a square svg with a viewBox");
  }
  const scale = BODY / Number(viewBox[1]);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">`,
    `<rect x="${INSET}" y="${INSET}" width="${BODY}" height="${BODY}" rx="${CORNER}" fill="#fff"/>`,
    `<g transform="translate(${INSET} ${INSET}) scale(${scale})">${inner[1]}</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

/**
 * Renders the logo into every iconset size with sips, then packs them into an icns with iconutil.
 * The iconset is left in `workDir` so the sizes can be checked.
 */
export async function buildIcon(out: string, workDir: string): Promise<string> {
  const svg = join(workDir, "icon.svg");
  const master = join(workDir, "icon.png");
  const iconset = join(workDir, "icon.iconset");
  await writeFile(svg, iconSvg(await readFile(LOGO_SVG, "utf8")));
  await run("sips", ["-s", "format", "png", svg, "--out", master]);
  await mkdir(iconset, { recursive: true });
  for (const image of ICONSET) {
    const size = String(image.pixels);
    await run("sips", ["-z", size, size, master, "--out", join(iconset, image.name)]);
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", out]);
  return iconset;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workDir = await mkdtemp(join(tmpdir(), "gandalf-icon-"));
  try {
    await mkdir(join(ICON_ICNS, ".."), { recursive: true });
    await buildIcon(ICON_ICNS, workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
