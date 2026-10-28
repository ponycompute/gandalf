import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Intent, Plan, SkillName, SkillSource, SkillView, Snapshot } from "@gandalf/skills";
import { invoke } from "../invoke";
import type { Flow } from "../changes/writeFlow";

/** Every skill from git or a folder, brought to its newest version. */
export const UPDATE_ALL: Intent = { kind: "update", skills: "all", pins: [] };

export function updateOne(skill: SkillName): Intent {
  return { kind: "update", skills: [skill], pins: [] };
}

/** True for a skill gandalf can update: one from git, or from a folder it still knows. */
export function canUpdate(skill: SkillView): boolean {
  const { source } = skill;
  return source?.kind === "git" || (source?.kind === "local" && source.path !== null);
}

/** A newer version a check found, and the source the skill had when it was found. */
export interface Found {
  readonly skill: SkillName;
  readonly from: string;
}

function sourceKey(source: SkillSource | null): string {
  return JSON.stringify(source);
}

/** The skills an update plan moves to a new version. */
export function updatedBy(plan: Plan): readonly SkillName[] {
  return plan.steps.flatMap((step) =>
    step.kind === "commitState"
      ? step.changes.flatMap((change) => (change.kind === "setSource" ? [change.skill] : []))
      : [],
  );
}

/**
 * What is known to be newer after `plan`: the skills an update plan checked take its answer, and
 * the rest keep what an earlier check found. Any other plan changes nothing.
 */
export function foundAfter(
  found: readonly Found[],
  plan: Plan,
  snapshot: Snapshot,
): readonly Found[] {
  const { intent } = plan;
  if (intent.kind !== "update") return found;
  const checked = intent.skills === "all" ? null : new Set(intent.skills);
  const kept = checked === null ? [] : found.filter((item) => !checked.has(item.skill));
  const fresh = updatedBy(plan).flatMap((skill) => {
    const view = snapshot.skills.find((candidate) => candidate.name === skill);
    return view === undefined ? [] : [{ skill, from: sourceKey(view.source) }];
  });
  return [...kept, ...fresh];
}

/**
 * The found skills still on the source they had when found, in library order. One that was
 * updated since, or removed, drops out without another check.
 */
export function pendingUpdates(found: readonly Found[], snapshot: Snapshot): readonly SkillName[] {
  const from = new Map(found.map((item) => [item.skill, item.from]));
  return snapshot.skills
    .filter((view) => from.get(view.name) === sourceKey(view.source))
    .map((view) => view.name);
}

function checksAll(intent: Intent): boolean {
  return intent.kind === "update" && intent.skills === "all";
}

export interface Updates {
  /** The skills with a newer version, which the Library marks. */
  readonly pending: readonly SkillName[];
  /** True while gandalf checks every skill, quietly or for a sheet. */
  readonly checking: boolean;
  /** Checks every skill without a sheet. A failed check, such as offline, keeps what was found. */
  readonly checkQuietly: () => void;
}

/**
 * What gandalf knows to be newer. A quiet check plans an update of every skill and keeps only
 * which skills it would move; an update planned in a sheet answers the same for the skills it
 * checked. Planning writes nothing, so a quiet check never stands in the user's way.
 */
export function useUpdates(snapshot: Snapshot | null, flow: Flow): Updates {
  const [found, setFound] = useState<readonly Found[]>([]);
  const [quiet, setQuiet] = useState(false);
  const latest = useRef(snapshot);
  useEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);
  const running = useRef(false);
  const checkQuietly = useCallback(() => {
    const current = latest.current;
    if (running.current || current === null || !current.skills.some(canUpdate)) return;
    running.current = true;
    setQuiet(true);
    void invoke(() => window.gandalf.plan(UPDATE_ALL)).then((result) => {
      running.current = false;
      setQuiet(false);
      const now = latest.current;
      if (!result.ok || !result.value.ok || now === null) return;
      const { plan } = result.value;
      setFound((before) => foundAfter(before, plan, now));
    });
  }, []);
  useEffect(() => {
    const now = latest.current;
    if (flow.kind !== "previewing" || now === null) return;
    const { plan } = flow;
    setFound((before) => foundAfter(before, plan, now));
  }, [flow]);
  const planning = flow.kind === "planning" && checksAll(flow.intent);
  const pending = useMemo(
    () => (snapshot === null ? [] : pendingUpdates(found, snapshot)),
    [found, snapshot],
  );
  return {
    pending,
    checking: quiet || planning,
    checkQuietly,
  };
}
