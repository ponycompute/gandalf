import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gandalf — the skill library that writes itself",
  description:
    "gandalf notices the work you repeat, drafts it as a skill, and links it into Claude Code, Codex, Cursor and 10 more coding agents.",
  icons: {
    icon: [
      { url: "/gandalf-logo.svg", media: "(prefers-color-scheme: light)" },
      { url: "/gandalf-logo-dark.svg", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
