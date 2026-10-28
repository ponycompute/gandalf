import { Alert02Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { KeyboardEvent } from "react";
import type { AgentId } from "@gandalf/skills";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { SKILL_DETAIL_TITLE } from "../skill/SkillDetail";
import type { Names } from "../vocabulary";
import { DiffView, shortHash } from "./DiffView";
import { variantsOf, type PlacedSkill } from "./model";
import { useSkillFiles, variantLabel } from "./VersionChoice";

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "Claude Code's", or "The one in ~/.agents/skills" for a folder no agent writes to. */
function versionOf(label: string): string {
  return label.startsWith("~") || label.startsWith("/") ? `The one in ${label}` : `${label}'s`;
}

interface TwoVersionsProps {
  readonly skill: PlacedSkill;
  readonly names: Names;
  readonly flow: Flow;
  readonly dispatch: (event: FlowEvent) => void;
  readonly onClose: () => void;
}

/**
 * The inspector for a skill gandalf could not bring in by itself, as its copies differ: which agents
 * have which version, how they differ, and Keep This, which plans keeping one through the sync sheet.
 */
export function TwoVersions({ skill, names, flow, dispatch, onClose }: TwoVersionsProps) {
  const variants = variantsOf(skill);
  const reads = useSkillFiles(variants);
  const labels = variants.map((variant) => variantLabel(variant, names));
  const agents = [...new Set(skill.copies.flatMap((copy): readonly AgentId[] => copy.readers))];
  const [first] = variants;
  const firstRead = reads[0];
  const planning = flow.kind === "planning";
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <aside
      aria-labelledby={SKILL_DETAIL_TITLE}
      onKeyDown={onKeyDown}
      className="gd-glass-flush flex h-full w-[clamp(240px,32vw,360px)] min-w-0 flex-col overflow-hidden"
    >
      <div className="flex items-start gap-1 px-4 pt-4 pb-2">
        <h2
          id={SKILL_DETAIL_TITLE}
          tabIndex={-1}
          className="min-w-0 flex-1 text-title-2 break-words select-text"
        >
          {skill.name}
        </h2>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className="grid size-6 place-items-center rounded-md text-label-secondary hover:bg-glass-selection"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
        </button>
      </div>
      <div
        role="region"
        tabIndex={0}
        aria-label={`About ${skill.name}`}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain text-callout focus-visible:-outline-offset-2"
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 pb-3">
          <dt className="text-label-secondary">Source</dt>
          <dd>{AND.format(labels)} folders</dd>
          <dt className="text-label-secondary">Library</dt>
          <dd>Not in your library until you keep one version</dd>
        </dl>
        <section aria-label="Agents" className="flex flex-col gap-2 px-4 pb-3">
          <h3 className="text-subheadline text-label-secondary">Agents</h3>
          <ul className="flex flex-wrap gap-1.5">
            {agents.map((agent) => (
              <li
                key={agent}
                className="flex h-6 items-center gap-1 rounded-full border border-accent/45 bg-accent/12 px-2"
              >
                <AgentLogo agent={agent} size={14} />
                <span className="whitespace-nowrap">{names.agent(agent)}</span>
                <HugeiconsIcon icon={Tick02Icon} size={12} className="text-accent" aria-hidden />
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Versions" className="flex flex-col gap-1.5 px-4 pb-3">
          <p className="flex items-center gap-2 rounded-md bg-conflict-tint px-2.5 py-1.5 text-status-conflict">
            <HugeiconsIcon icon={Alert02Icon} size={14} className="flex-none" aria-hidden />
            <span className="min-w-0 flex-1 text-label">
              {AND.format(labels)} each have their own {skill.name}
            </span>
          </p>
          {variants.map((variant, index) => (
            <div
              key={variant.hash}
              data-variant={variant.hash}
              className="flex items-center gap-2.5 rounded-lg border border-separator px-2.5 py-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>
                  {versionOf(labels[index] ?? "")} ·{" "}
                  <span className="font-mono text-path">{shortHash(variant.hash)}</span>
                </span>
                {variant.at.map((at) => (
                  <PathText key={at.path} path={at.path} />
                ))}
              </span>
              <Button
                size="small"
                disabled={planning}
                aria-label={`Keep ${versionOf(labels[index] ?? "")} version of ${skill.name}`}
                onClick={() =>
                  dispatch({
                    kind: "plan",
                    intent: { kind: "keep", name: skill.name, hash: variant.hash },
                  })
                }
              >
                Keep This
              </Button>
            </div>
          ))}
          <p className="text-label-secondary">
            gandalf moves the one you keep into your library and links it into every agent that had
            a copy. The others go to the Trash.
          </p>
        </section>
        <section
          aria-label="SKILL.md"
          className="flex-1 border-t border-separator bg-content px-4 pt-3 pb-4"
        >
          {first === undefined || firstRead?.kind !== "read" ? (
            <p className="text-label-secondary">Reading SKILL.md…</p>
          ) : firstRead.text === null ? (
            <p className="text-label-secondary">gandalf cannot read this SKILL.md.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {variants.slice(1).map((variant, index) => {
                const read = reads[index + 1];
                return read?.kind !== "read" || read.text === null ? null : (
                  <DiffView
                    key={variant.hash}
                    before={{
                      label: labels[0] ?? "",
                      hash: first.hash,
                      text: firstRead.text ?? "",
                    }}
                    after={{ label: labels[index + 1] ?? "", hash: variant.hash, text: read.text }}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
