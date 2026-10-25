import type { SampleSkill } from "@/data/skills";
import { StatusGlyph } from "./StatusGlyph";

interface SkillMatrixProps {
  skills: readonly SampleSkill[];
  columns: readonly string[];
  /** Index of the row drawn as the focused selection, if any. */
  selected?: number;
  /** Hide descriptions on narrow screens. */
  compact?: boolean;
}

export function SkillMatrix({ skills, columns, selected, compact = false }: SkillMatrixProps) {
  return (
    <table className={`gd-table gd-matrix${compact ? " gd-matrix-compact" : ""}`}>
      <thead>
        <tr>
          <th>Skill</th>
          {columns.map((column) => (
            <th key={column} className="gd-agent">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {skills.map((skill, row) => (
          <tr key={skill.name} aria-selected={row === selected ? true : undefined}>
            <td>
              <span className="gd-skill-name">{skill.name}</span>
              <span className="gd-skill-desc">{skill.description}</span>
            </td>
            {skill.cells.slice(0, columns.length).map((verdict, column) => (
              <td key={column} className="gd-cell">
                <StatusGlyph verdict={verdict} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
