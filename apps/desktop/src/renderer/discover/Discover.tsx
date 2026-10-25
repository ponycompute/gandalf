import { useId, useMemo, type ReactNode } from "react";
import type { Entry, Intent, SkillName, Snapshot } from "@gandalf/skills";
import { AppliedSummary } from "../changes/AppliedSummary";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { StatusGlyph } from "../library/StatusGlyph";
import {
  cannotAdoptReason,
  conflictReason,
  keepsOwnVersion,
  matchesLibrary,
  type Names,
} from "../vocabulary";
import { adoptAllNames, discoverModel, type PlacedSkill, type Unadoptable } from "./model";

function adopt(names: readonly SkillName[]): Intent {
  return { kind: "adopt", names, pick: [] };
}

function linkTarget(entry: Entry): string | undefined {
  return entry.observed.kind === "foreignLink" ? entry.observed.target : undefined;
}

interface SectionProps {
  readonly title: string;
  readonly count: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

function Section({ title, count, action, children }: SectionProps) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <div className="flex min-h-row-height items-center gap-3 px-5 pt-3 pb-1">
        <h2 id={heading} className="text-title-3">
          {title}
        </h2>
        <span className="text-callout text-label-secondary tabular-nums">{count}</span>
        <span className="flex-1" />
        {action}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

const ROW =
  "grid min-h-row-height grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-3 border-t border-separator px-5 py-1";

function PlacedRow({
  skill,
  onAdopt,
}: {
  readonly skill: PlacedSkill;
  readonly onAdopt: () => void;
}) {
  return (
    <li className={ROW} data-skill={skill.name}>
      <StatusGlyph verdict="unmanaged" withWord />
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold select-text">{skill.name}</span>
        {skill.copies.map((copy) => (
          <PathText key={copy.path} path={copy.path} />
        ))}
        {skill.inLibrary ? (
          <span className="text-callout text-label-secondary">{matchesLibrary(skill.name)}</span>
        ) : skill.agree ? null : (
          <span className="text-callout text-label-secondary">
            The copies differ. Adopt it to choose which version to keep.
          </span>
        )}
      </span>
      <Button size="small" aria-label={`Adopt ${skill.name}`} onClick={onAdopt}>
        Adopt
      </Button>
    </li>
  );
}

function ConflictRow({ entry, names }: { readonly entry: Entry; readonly names: Names }) {
  return (
    <li className={ROW} data-skill={entry.name}>
      <StatusGlyph verdict="conflict" withWord />
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold select-text">{entry.name}</span>
        <PathText path={entry.path} target={linkTarget(entry)} />
        <span className="text-callout text-label-secondary">
          {conflictReason(entry.observed, names)}
        </span>
      </span>
      <span />
    </li>
  );
}

function CannotAdoptRow({ item, names }: { readonly item: Unadoptable; readonly names: Names }) {
  const { entry } = item;
  return (
    <li className={ROW} data-skill={item.kind === "ownVersion" ? item.name : undefined}>
      <StatusGlyph verdict="unmanaged" withWord />
      <span className="flex min-w-0 flex-col">
        {item.kind === "ownVersion" ? (
          <span className="font-semibold select-text">{item.name}</span>
        ) : null}
        <PathText path={entry.path} target={linkTarget(entry)} />
        <span className="text-callout text-label-secondary">
          {item.kind === "ownVersion"
            ? keepsOwnVersion(item.name, entry.root, names)
            : cannotAdoptReason(entry.observed, names)}
        </span>
      </span>
      <span />
    </li>
  );
}

function adoptAllLabel(count: number): string {
  return `Adopt ${count} ${count === 1 ? "Skill" : "Skills"}`;
}

interface DiscoverProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
}

/**
 * What gandalf found in agents' skills folders that it does not manage: skills you placed, which
 * Adopt moves into the library, copies in the way of a library skill, which it never replaces, and
 * the rest, which Adopt would leave where they are.
 */
export function Discover({ snapshot, flow, names, dispatch }: DiscoverProps) {
  const model = useMemo(() => discoverModel(snapshot), [snapshot]);
  const agreeing = adoptAllNames(model);
  const plan = (intent: Intent) => dispatch({ kind: "plan", intent });
  const empty =
    model.notManaged.length === 0 && model.conflicts.length === 0 && model.cannotAdopt.length === 0;
  return (
    <div className="pb-5">
      <div role="status" className="sticky left-0">
        {flow.kind === "applied" ? <AppliedSummary results={flow.results} names={names} /> : null}
      </div>
      {empty ? (
        <div className="flex flex-col items-center gap-2 px-5 pt-16 text-center">
          <p className="text-large-title">Nothing to adopt.</p>
          <p className="text-label-secondary">
            Skills you place in an agent&apos;s skills folder show up here.
          </p>
        </div>
      ) : null}
      {model.notManaged.length === 0 ? null : (
        <Section
          title="Not managed"
          count={model.notManaged.length}
          action={
            agreeing.length === 0 ? null : (
              <Button size="small" onClick={() => plan(adopt(agreeing))}>
                {adoptAllLabel(agreeing.length)}
              </Button>
            )
          }
        >
          {model.notManaged.map((skill) => (
            <PlacedRow key={skill.name} skill={skill} onAdopt={() => plan(adopt([skill.name]))} />
          ))}
        </Section>
      )}
      {model.conflicts.length === 0 ? null : (
        <Section title="Conflict" count={model.conflicts.length}>
          {model.conflicts.map((entry) => (
            <ConflictRow key={entry.path} entry={entry} names={names} />
          ))}
        </Section>
      )}
      {model.cannotAdopt.length === 0 ? null : (
        <Section title="Cannot adopt" count={model.cannotAdopt.length}>
          {model.cannotAdopt.map((item) => (
            <CannotAdoptRow key={item.entry.path} item={item} names={names} />
          ))}
        </Section>
      )}
    </div>
  );
}
