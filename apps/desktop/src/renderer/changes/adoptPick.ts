import type {
  AdoptPick,
  ContentHash,
  EntryLocation,
  Intent,
  Plan,
  SkillName,
  Step,
} from "@gandalf/skills";

/** The adopt intent planned again with `pick` replacing any earlier pick for the same name. */
export function withPick(intent: Intent, pick: AdoptPick): Intent {
  if (intent.kind !== "adopt") return intent;
  return { ...intent, pick: [...intent.pick.filter((p) => p.name !== pick.name), pick] };
}

/** A version the user picked that the plan does not adopt, and the version it adopts instead. */
export interface IgnoredPick {
  readonly name: SkillName;
  readonly picked: ContentHash;
  readonly adopted: ContentHash;
  /** The copy the plan moves into the library, null when it links the library's own version. */
  readonly from: EntryLocation | null;
}

type Taking = Extract<Step, { kind: "adoptMove" | "trashDuplicate" }>;

/**
 * The picks a plan does not honour. Once a name has one version left, as when the picked copy was
 * deleted before the plan, the core ignores the pick and adopts that version without asking. Every
 * copy a plan takes for a name has the hash it adopts: the one it moves, or the library's.
 */
export function ignoredPicks(plan: Plan): readonly IgnoredPick[] {
  if (plan.intent.kind !== "adopt") return [];
  const ignored: IgnoredPick[] = [];
  for (const pick of plan.intent.pick) {
    if (pick.kind !== "hash") continue;
    const taking = plan.steps.filter(
      (step): step is Taking =>
        (step.kind === "adoptMove" || step.kind === "trashDuplicate") && step.skill === pick.name,
    );
    const [first] = taking;
    if (first === undefined || first.hash === pick.hash) continue;
    ignored.push({
      name: pick.name,
      picked: pick.hash,
      adopted: first.hash,
      from: taking.find((step) => step.kind === "adoptMove")?.from ?? null,
    });
  }
  return ignored;
}
