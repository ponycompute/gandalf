// SKILL.md frontmatter. Only `name` and `description` matter to gandalf.

import { parseSkillName } from "./parse.js";
import type { SkillName } from "./types.js";

/** Boundary parse. Tolerates missing or malformed frontmatter. */
export function parseFrontmatter(text: string): {
  readonly name: string | null;
  readonly description: string | null;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) {
      fields.set(field[1], unquote(field[2].trim()));
    }
  }
  return {
    name: nonEmpty(fields.get("name")),
    description: nonEmpty(fields.get("description")),
  };
}

/** Frontmatter name if it parses as a SkillName, else the folder name if it does, else null. */
export function intakeName(declaredName: string | null, folderName: string): SkillName | null {
  return (
    (declaredName === null ? null : parseSkillName(declaredName)) ?? parseSkillName(folderName)
  );
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  return quoted ? (quoted[1] ?? quoted[2] ?? "") : value;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}
