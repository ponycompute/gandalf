// Boundary parsers for the values callers send in.

import { isAbsolute, normalize } from "node:path";
import type { AbsPath, ContentHash, SkillName } from "./types.js";

export function parseSkillName(raw: string): SkillName | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw) && !raw.includes("..")
    ? (raw as SkillName)
    : null;
}

export function parseAbsPath(raw: string): AbsPath | null {
  return isAbsolute(raw) ? (normalize(raw).replace(/(.)\/+$/, "$1") as AbsPath) : null;
}

export function parseContentHash(raw: unknown): ContentHash | null {
  return typeof raw === "string" && /^sha256:[0-9a-f]{64}$/.test(raw) ? (raw as ContentHash) : null;
}
