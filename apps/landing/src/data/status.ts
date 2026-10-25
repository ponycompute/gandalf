// Glyphs, words and tokens from the design system's StatusGlyph table. The CLI prints the same
// glyphs; apps/desktop/src/renderer/vocabulary.ts holds the app's copy.

export const STATUS = {
  ok: { glyph: "●", word: "Linked", token: "linked" },
  missing: { glyph: "○", word: "Will add", token: "change" },
  repair: { glyph: "◐", word: "Will update", token: "change" },
  extra: { glyph: "−", word: "Will remove", token: "change" },
  blocked: { glyph: "!", word: "Blocked", token: "conflict" },
  conflict: { glyph: "✗", word: "Conflict", token: "conflict" },
  unmanaged: { glyph: "?", word: "Not managed", token: "unmanaged" },
  untouched: { glyph: "~", word: "Left alone", token: "off" },
  off: { glyph: "·", word: "Off", token: "off" },
} as const;

export type Verdict = keyof typeof STATUS;

export const VERDICTS = Object.keys(STATUS) as Verdict[];
