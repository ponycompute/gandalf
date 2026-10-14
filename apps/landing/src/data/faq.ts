// Questions people search for, answered once: the FAQ section renders these
// and the page's FAQPage structured data is built from the same list.
export interface FaqItem {
  question: string;
  answer: string;
}

export const faq: FaqItem[] = [
  {
    question: "What is Gandalf?",
    answer:
      "Gandalf is an open-source command-line tool that keeps agent skills in sync across Claude Code, Codex, and Cursor, and hands the work one coding agent started over to the next. It is a single local binary with no account and no cloud service.",
  },
  {
    question: "Which coding agents does Gandalf support?",
    answer:
      "Skill management works with Claude Code, Codex, and Cursor, for both user-level and project-level skills. Work handoff works between Claude Code and Codex.",
  },
  {
    question: "What is an agent skill?",
    answer:
      "A skill is a folder with a SKILL.md file: a name, a description of when to use it, and instructions. The agent loads the instructions only when a task matches the description, so a skill can hold project knowledge without filling every conversation.",
  },
  {
    question: "How do I sync skills between Claude Code, Codex, and Cursor?",
    answer:
      "Run gandalf to see every skill and which agents have it, then gandalf skill sync to copy each skill to the agents that are missing it. Add --dry-run to preview the changes. Copies that differ are never overwritten unless you name the agent whose copy wins with --from.",
  },
  {
    question: "How do I move work from Claude Code to Codex without explaining it again?",
    answer:
      "After gandalf init, a local service records what Claude Code and Codex do in a project. The next agent reads a handoff contract over MCP, with the objective, what is done, and what is left, instead of asking you to explain the task again.",
  },
  {
    question: "Does Gandalf send my code or sessions anywhere?",
    answer:
      "No. Gandalf runs on your machine and has no server and no account. Handoff recording is opt-in, and its evidence is encrypted with a key kept in the macOS keychain.",
  },
  {
    question: "Is Gandalf free?",
    answer:
      "Yes. The CLI is free and open source under the Apache-2.0 license. A team plan for sharing skills across a team is in early access.",
  },
];
