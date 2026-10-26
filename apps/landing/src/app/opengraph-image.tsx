import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { AGENTS } from "@/data/agents";

export const alt = "Gandalf — the skill library that writes itself";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* Colors are the light scheme in design/tokens.css: --page, --g-label, --g-label-secondary, --g-accent. */
export default async function OpengraphImage() {
  const logo = await readFile(join(process.cwd(), "public/gandalf-logo.svg"), "base64");

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        background: "#ffffff",
        color: "#1d1d1f",
      }}
    >
      <img src={`data:image/svg+xml;base64,${logo}`} width={112} height={112} alt="" />
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>
          The skill library that writes itself.
        </div>
        <div style={{ fontSize: 30, color: "#5e5e63", lineHeight: 1.3 }}>
          {`Linked into Claude Code, Codex, Cursor and ${AGENTS.length - 3} more coding agents.`}
        </div>
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, color: "#b53b25" }}>usegandalf.com</div>
    </div>,
    size,
  );
}
