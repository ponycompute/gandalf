import type { AgentId, Plan } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { installFacts, installTitle } from "./InstallSummary";

const INSTALLED = ["claude_code", "codex", "cursor"] as AgentId[];
const git = (subpath: string) => ({
  kind: "git",
  url: "https://github.com/acme/skills.git",
  ref: null,
  subpath,
  commit: "c".repeat(40),
});

function plan(fields: object): Plan {
  return {
    intent: { kind: "install", source: git("skills/pdf"), agents: "all" },
    steps: [],
    notDone: [],
    fingerprint: "sha256:0",
    ...fields,
  } as unknown as Plan;
}

describe("installFacts", () => {
  it("names the skills the plan tracks, which of them it adds, and the agents they reach", () => {
    const facts = installFacts(
      plan({
        intent: {
          kind: "install",
          source: git("skills/pdf"),
          agents: ["cursor", "claude_code"],
          also: [git("skills/docx")],
        },
        steps: [
          { kind: "libraryAdd", skill: "pdf" },
          {
            kind: "commitState",
            changes: [
              { kind: "track", skill: "pdf", source: git("skills/pdf") },
              { kind: "track", skill: "docx", source: git("skills/docx") },
            ],
          },
          { kind: "copy", skill: "pdf" },
        ],
      }),
      INSTALLED,
    );
    expect(facts).toEqual({
      skills: [
        { name: "pdf", source: git("skills/pdf"), adds: true },
        { name: "docx", source: git("skills/docx"), adds: false },
      ],
      agents: ["claude_code", "cursor"],
      copies: true,
      changes: 3,
    });
    expect(facts === null ? null : installTitle(facts)).toBe("Install 2 skills?");
  });

  it("titles one skill by name, and leaves other plans alone", () => {
    const one = installFacts(
      plan({
        steps: [
          { kind: "commitState", changes: [{ kind: "track", skill: "pdf", source: git("x") }] },
        ],
      }),
      INSTALLED,
    );
    expect(one === null ? null : installTitle(one)).toBe("Install pdf?");
    expect(installFacts(plan({ intent: { kind: "sync", skills: "all" } }), INSTALLED)).toBeNull();
  });
});
