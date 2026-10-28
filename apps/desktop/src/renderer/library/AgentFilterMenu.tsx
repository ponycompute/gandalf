import type { AgentId, Snapshot } from "@gandalf/skills";
import { AgentLogo } from "../design/AgentLogo";
import { Menu, type MenuItem } from "../design/Menu";
import type { Names } from "../vocabulary";
import { filterChoices, skillsIn, unmanagedIn } from "./agentFilter";

interface AgentFilterProps {
  readonly snapshot: Snapshot;
  readonly names: Names;
  readonly agent: AgentId | null;
  readonly onChange: (agent: AgentId | null) => void;
}

/** The Library toolbar's pop-up: every skill, or one agent's, each choice with its count. */
export function AgentFilter({ snapshot, names, agent, onChange }: AgentFilterProps) {
  const items: readonly MenuItem[] = [
    {
      label: "All Agents",
      checked: agent === null,
      detail: String(snapshot.skills.length),
      onSelect: () => onChange(null),
    },
    ...filterChoices(snapshot).map((choice, at) => ({
      label: names.agent(choice.agent),
      icon: <AgentLogo agent={choice.agent} size={16} />,
      checked: choice.agent === agent,
      detail: String(choice.count),
      separated: at === 0,
      onSelect: () => onChange(choice.agent),
    })),
  ];
  const shown = agent === null ? "All Agents" : names.agent(agent);
  return (
    <Menu
      label={`Show skills in: ${shown}`}
      exclusive
      face={{
        capsule: (
          <>
            {agent === null ? null : <AgentLogo agent={agent} size={16} />}
            <span>{shown}</span>
          </>
        ),
      }}
      items={items}
    />
  );
}

/** The toolbar's count line while the Library is filtered to an agent. */
export function filteredLine(snapshot: Snapshot, names: Names, agent: AgentId): string {
  const has = skillsIn(snapshot, agent).length;
  const unmanaged = unmanagedIn(snapshot, agent).length;
  const line = `${has} of ${snapshot.skills.length} ${snapshot.skills.length === 1 ? "skill" : "skills"} in ${names.agent(agent)}`;
  return unmanaged === 0 ? line : `${line} · ${unmanaged} not managed`;
}
