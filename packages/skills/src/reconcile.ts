// The pure core: desired state x observed state -> verdict per entry -> steps.

import type {
  ContentHash,
  Desired,
  Observed,
  Owned,
  Reconciled,
  RootRole,
  SkillName,
  Unowned,
} from "./types.js";

export interface VerdictContext {
  readonly role: RootRole;
  readonly tracked: (skill: SkillName) => boolean;
  /** The library has a dir of that name, valid or not. */
  readonly inLibrary: (skill: SkillName) => boolean;
  /** null when the library has no such skill, or the dir has no SKILL.md. */
  readonly libraryHash: (skill: SkillName) => ContentHash | null;
}

/**
 * The verdict table. Exhaustive over (role, desired, observed.kind). The return type ties each
 * verdict to its evidence, so `extra` and `repair` can only be built from Owned observations.
 *
 *   scan root,  Owned                         -> untouched(scanRoot)
 *   scan root,  Unowned                       -> unmanaged
 *   no desire,  Owned, skill untracked in lib -> untouched(untracked)
 *   no desire,  Owned otherwise               -> extra
 *   no desire,  Unowned                       -> unmanaged
 *   desire,     library lacks skill           -> blocked (Absent | Owned), conflict (Unowned)
 *   desire,     absent                        -> missing
 *   desire,     owned, for another skill      -> repair(otherSkill)
 *   desire,     link, mode copy               -> repair(wrongMode)
 *   desire,     clean copy, mode link         -> repair(wrongMode)
 *   desire,     clean copy, hash != library   -> repair(staleCopy)
 *   desire,     link or clean copy, matching  -> ok   (mode auto accepts either)
 *   desire,     Unowned                       -> conflict
 *
 * Returns null for (no desire, absent): such entries do not exist.
 */
export function reconcileEntry(
  observed: Observed,
  desired: Desired | null,
  context: VerdictContext,
): Reconciled | null {
  if (observed.kind === "absent") {
    if (context.role === "scan" || desired === null) return null;
    return context.libraryHash(desired.skill) === null
      ? { verdict: "blocked", observed, desired }
      : { verdict: "missing", observed, desired };
  }
  if (!isOwned(observed)) {
    return context.role === "scan" || desired === null
      ? { verdict: "unmanaged", observed, desired: null }
      : { verdict: "conflict", observed, desired };
  }
  if (context.role === "scan") {
    return { verdict: "untouched", observed, desired: null, why: "scanRoot" };
  }
  if (desired === null) {
    return context.inLibrary(observed.skill) && !context.tracked(observed.skill)
      ? { verdict: "untouched", observed, desired: null, why: "untracked" }
      : { verdict: "extra", observed, desired: null };
  }
  const libraryHash = context.libraryHash(desired.skill);
  if (libraryHash === null) return { verdict: "blocked", observed, desired };
  if (observed.skill !== desired.skill) {
    return { verdict: "repair", observed, desired, why: "otherSkill" };
  }
  if (observed.kind === "link") {
    return desired.mode === "copy"
      ? { verdict: "repair", observed, desired, why: "wrongMode" }
      : { verdict: "ok", observed, desired };
  }
  if (desired.mode === "link") return { verdict: "repair", observed, desired, why: "wrongMode" };
  return observed.hash === libraryHash
    ? { verdict: "ok", observed, desired }
    : { verdict: "repair", observed, desired, why: "staleCopy" };
}

export function isOwned(observed: Owned | Unowned): observed is Owned {
  return observed.kind === "link" || observed.kind === "cleanCopy";
}
