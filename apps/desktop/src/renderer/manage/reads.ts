import type { AdoptVariant } from "@gandalf/skills";

/** One variant's SKILL.md: still being read, or its text, null when main would not serve it. */
export type Read =
  { readonly kind: "loading" } | { readonly kind: "read"; readonly text: string | null };

/** Reads with the key of the variants they were made for. */
export interface StoredReads {
  readonly key: string;
  readonly reads: readonly Read[];
}

/** The variants' hashes and the folders read for them, which tell one read from the next. */
export function readKey(variants: readonly AdoptVariant[]): string {
  return JSON.stringify(variants.map((variant) => [variant.hash, variant.at[0]?.path ?? ""]));
}

/**
 * The reads to show for `key`. Reads made for other variants show as loading, so a frame painted
 * before the new reads land never puts an old SKILL.md under a new hash.
 */
export function readsFor(stored: StoredReads | null, key: string, count: number): readonly Read[] {
  return stored?.key === key
    ? stored.reads
    : Array.from({ length: count }, (): Read => ({ kind: "loading" }));
}
