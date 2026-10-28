import type { AdoptVariant, ContentHash, Entry, SkillName, Snapshot } from "@gandalf/skills";

/** One name you placed by hand, with every copy of it that Adopt would take. */
export interface PlacedSkill {
  readonly name: SkillName;
  readonly copies: readonly Entry[];
  /**
   * True when adopting needs no choice: the library already holds the name, so only copies that
   * match it are taken, or every copy adopt sees has the same content.
   */
  readonly agree: boolean;
  /** True when the library holds this name, so every copy listed matches its version. */
  readonly inLibrary: boolean;
}

/** An entry gandalf does not manage that Adopt would not take. */
export type Unadoptable =
  /** Not a skill: no SKILL.md, a link you made, gandalf's copy you edited, or an invalid name. */
  | { readonly kind: "notASkill"; readonly entry: Entry }
  /** A skill you placed whose name the library holds with other content. */
  | { readonly kind: "ownVersion"; readonly entry: Entry; readonly name: SkillName };

export interface ManageModel {
  readonly notManaged: readonly PlacedSkill[];
  /**
   * What is in a slot gandalf wants for a library skill and Adopt would not take: the core's
   * conflict verdict, less the skill folders Adopt takes for their name.
   */
  readonly conflicts: readonly Entry[];
  readonly cannotAdopt: readonly Unadoptable[];
}

/** The core's intake rule: the SKILL.md name when it is a valid skill name, else the folder's. */
function skillName(raw: string | null): SkillName | null {
  return raw !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw) && !raw.includes("..")
    ? (raw as SkillName)
    : null;
}

export function intakeName(declaredName: string | null, folderName: string): SkillName | null {
  return skillName(declaredName) ?? skillName(folderName);
}

const byPath = (a: Entry, b: Entry) => a.path.localeCompare(b.path);

/**
 * Sorts the entries the way the core's adopt sees them. Adopt takes every skill folder you placed
 * under its intake name, whatever its verdict: a copy that matches the library's version becomes a
 * link, one that differs stays where it is, and with nothing in the library the copies must agree.
 */
export function manageModel(snapshot: Snapshot): ManageModel {
  const library = new Map<string, string>();
  for (const skill of snapshot.skills) if (skill.hash !== null) library.set(skill.name, skill.hash);
  const placed = new Map<SkillName, Entry[]>();
  // Every hash adopt would see for a name, conflicts included, to tell whether it must ask.
  const hashes = new Map<SkillName, Set<string>>();
  const conflicts: Entry[] = [];
  const cannotAdopt: Unadoptable[] = [];
  for (const entry of snapshot.entries) {
    if (entry.verdict !== "unmanaged" && entry.verdict !== "conflict") continue;
    const { observed } = entry;
    const name =
      observed.kind === "skillDir" ? intakeName(observed.declaredName, entry.name) : null;
    // Adopt never takes a project's own skills: they belong to the project.
    if (observed.kind !== "skillDir" || name === null || entry.project !== null) {
      if (entry.verdict === "conflict") conflicts.push(entry);
      else if (entry.project !== null && observed.kind === "skillDir") continue;
      else cannotAdopt.push({ kind: "notASkill", entry });
      continue;
    }
    hashes.set(name, (hashes.get(name) ?? new Set()).add(observed.hash));
    const inLibrary = library.get(name);
    // With no library folder, adopt takes every copy of the name, a conflict in gandalf's slot too.
    if (inLibrary === undefined || inLibrary === observed.hash) {
      placed.set(name, [...(placed.get(name) ?? []), entry]);
    } else if (entry.verdict === "conflict") {
      conflicts.push(entry);
    } else {
      cannotAdopt.push({ kind: "ownVersion", entry, name });
    }
  }
  const notManaged = [...placed]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, copies]): PlacedSkill => ({
      name,
      copies: copies.sort(byPath),
      agree: library.has(name) || hashes.get(name)?.size === 1,
      inLibrary: library.has(name),
    }));
  return {
    notManaged,
    conflicts: conflicts.sort(byPath),
    cannotAdopt: cannotAdopt.sort((a, b) => byPath(a.entry, b.entry)),
  };
}

/** The names Adopt All plans: every one whose copies agree. */
export function adoptAllNames(model: ManageModel): readonly SkillName[] {
  return model.notManaged.filter((skill) => skill.agree).map((skill) => skill.name);
}

/** The names whose copies differ, each waiting in the library for the user to keep one version. */
export function twoVersions(model: ManageModel): readonly PlacedSkill[] {
  return model.notManaged.filter((skill) => !skill.agree);
}

/** A name's copies grouped by content, in hash order, as adopt groups them. */
export function variantsOf(skill: PlacedSkill): readonly AdoptVariant[] {
  const byHash = new Map<ContentHash, Entry[]>();
  for (const copy of skill.copies) {
    if (copy.observed.kind !== "skillDir") continue;
    byHash.set(copy.observed.hash, [...(byHash.get(copy.observed.hash) ?? []), copy]);
  }
  return [...byHash].sort(([a], [b]) => a.localeCompare(b)).map(([hash, at]) => ({ hash, at }));
}
