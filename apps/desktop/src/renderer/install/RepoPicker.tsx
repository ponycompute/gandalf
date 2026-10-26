import { useEffect, useRef, type ReactNode } from "react";
import type { SkillName, Snapshot } from "@gandalf/skills";
import { Checkbox } from "../design/Checkbox";
import { SettingsGroup } from "../settings/SettingsGroup";
import { pickStanding, type PickStanding, type RepoListing } from "./form";

const STANDING_TEXT = {
  inLibrary: "Already in the library",
  nameTaken: "A skill by this name from another source is in the library",
} as const satisfies Record<Exclude<PickStanding, "new">, string>;

interface RepoPickerProps {
  readonly listing: Extract<RepoListing, { kind: "ready" }>;
  readonly snapshot: Snapshot;
  /** Choose All's id, which takes focus when no skill is chosen. */
  readonly id: string;
  readonly onChosen: (chosen: readonly SkillName[]) => void;
  readonly help: ReactNode;
}

/**
 * The skills a repository holds, each with a checkbox, and Choose All over the ones that can be
 * installed. A skill already in the library, or whose name another source holds, cannot be chosen.
 */
export function RepoPicker({ listing, snapshot, id, onChosen, help }: RepoPickerProps) {
  const rows = listing.skills.map((skill) => ({
    skill,
    standing: pickStanding(skill, listing.url, snapshot),
  }));
  const open = rows.filter((row) => row.standing === "new").map((row) => row.skill.name);
  const chosen = listing.chosen.filter((name) => open.includes(name));
  const all = open.length > 0 && chosen.length === open.length;
  const some = chosen.length > 0 && !all;
  const chooseAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (chooseAll.current !== null) chooseAll.current.indeterminate = some;
  }, [some]);

  const summary =
    open.length === rows.length
      ? `${open.length} ${open.length === 1 ? "skill" : "skills"} can be installed`
      : `${open.length} ${open.length === 1 ? "skill" : "skills"} can be installed · ${rows.length - open.length} ${rows.length - open.length === 1 ? "is" : "are"} already in the library or taken`;

  return (
    <SettingsGroup
      title={`Skills in this repository · ${rows.length}`}
      label="Skills in this repository"
    >
      {rows.length === 0 ? (
        <li className="px-3.5 py-2.5 text-callout text-label-secondary">
          No SKILL.md in this repository at this branch or tag.
        </li>
      ) : (
        <>
          <li className="flex items-center gap-3 px-3.5 py-2.5">
            <Checkbox
              ref={chooseAll}
              id={id}
              aria-label="Choose All"
              aria-describedby={`${id}-summary`}
              checked={all}
              disabled={open.length === 0}
              onChange={(event) => onChosen(event.target.checked ? open : [])}
            />
            <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
              <span>Choose All</span>
              <span id={`${id}-summary`} className="text-callout text-label-secondary">
                {summary}
              </span>
            </label>
          </li>
          {rows.map(({ skill, standing }) => {
            const box = `${id}-${skill.name}`;
            const takeable = standing === "new";
            return (
              <li
                key={skill.name}
                className={`flex items-center gap-3 px-3.5 py-2.5 ${takeable ? "" : "text-label-secondary"}`}
              >
                <Checkbox
                  id={box}
                  aria-label={skill.name}
                  aria-describedby={`${box}-about`}
                  checked={takeable && chosen.includes(skill.name)}
                  disabled={!takeable}
                  onChange={(event) =>
                    onChosen(
                      event.target.checked
                        ? open.filter((name) => name === skill.name || chosen.includes(name))
                        : chosen.filter((name) => name !== skill.name),
                    )
                  }
                />
                <label htmlFor={box} className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{skill.name}</span>
                  <span id={`${box}-about`} className="truncate text-callout text-label-secondary">
                    {takeable ? (skill.description ?? "") : STANDING_TEXT[standing]}
                  </span>
                </label>
                <span className="flex-none font-mono text-path text-label-secondary">
                  {skill.subpath ?? "/"}
                </span>
              </li>
            );
          })}
        </>
      )}
      <li className="px-3.5 py-2 empty:hidden">{help}</li>
    </SettingsGroup>
  );
}
