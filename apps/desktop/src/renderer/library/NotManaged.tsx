import { useId } from "react";
import type { AgentId, Intent } from "@gandalf/skills";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { tilde, type Names } from "../vocabulary";
import type { UnmanagedSkill } from "./agentFilter";

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

interface NotManagedProps {
  readonly agent: AgentId;
  readonly skills: readonly UnmanagedSkill[];
  readonly names: Names;
  readonly plan: (intent: Intent) => void;
}

/**
 * The skills sitting in an agent's own folders that the library does not manage, under the
 * agent's library skills. Adopt plans the same move Discover does, every copy of the name included.
 */
export function NotManaged({ agent, skills, names, plan }: NotManagedProps) {
  const heading = useId();
  const folders = [...new Set(skills.map(({ entry }) => tilde(entry.root, names)))];
  return (
    <section aria-labelledby={heading} className="mx-3 mb-3 border-t border-separator">
      <div className="flex flex-col gap-0.5 px-3 pt-3.5 pb-2">
        <h2 id={heading} className="font-semibold">
          Not managed in {names.agent(agent)} · {skills.length}
        </h2>
        <p className="text-callout text-label-secondary">
          In {AND.format(folders)}, but not in your library. Adopt one and gandalf keeps it in step
          with the rest.
        </p>
      </div>
      <ul aria-label={`Not managed in ${names.agent(agent)}`}>
        {skills.map(({ name, entry }) => (
          <li key={name} data-skill={name} className="flex items-center gap-3 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold select-text">{name}</span>
              <PathText path={entry.path} />
            </span>
            <Button
              size="small"
              aria-label={`Adopt ${name}`}
              onClick={() => plan({ kind: "adopt", names: [name], pick: [] })}
            >
              Adopt…
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
