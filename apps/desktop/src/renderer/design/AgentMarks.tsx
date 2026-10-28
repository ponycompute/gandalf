import type { AgentId } from "@gandalf/skills";
import { AgentLogo } from "./AgentLogo";

/** Agent marks overlapping in a row, as the library list shows a skill's agents. */
export function AgentMarks({ agents }: { readonly agents: readonly AgentId[] }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center">
      {agents.map((agent) => (
        <span
          key={agent}
          className="-ml-1.5 grid size-6 place-items-center rounded-full border border-separator bg-content first:ml-0"
        >
          <AgentLogo agent={agent} size={14} />
        </span>
      ))}
    </span>
  );
}
