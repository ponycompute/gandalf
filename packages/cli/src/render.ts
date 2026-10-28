// Output. JSON mode prints the package's own values: they are plain JSON by construction, so there
// is no DTO layer to drift from the domain types. Text mode is presentation only.

import type {
  AgentId,
  ApplyOutcome,
  Enablement,
  Entry,
  Materialize,
  NotDone,
  Observed,
  Plan,
  PlanError,
  Snapshot,
  StateChange,
  Step,
  StepResult,
  Verdict,
} from "@gandalf/skills";

export interface Render {
  agents(snapshot: Snapshot): void;
  matrix(snapshot: Snapshot, agent: AgentId | null): void;
  scan(snapshot: Snapshot): void;
  status(snapshot: Snapshot): void;
  projects(snapshot: Snapshot): void;
  plan(plan: Plan, dryRun: boolean): void;
  planError(error: PlanError): void;
  inputError(field: string, message: string): void;
  applied(plan: Plan, outcome: ApplyOutcome): void;
}

type Print = (line: string) => void;

export function jsonRender(print: Print): Render {
  const emit = (value: unknown) => print(JSON.stringify(value, null, 2));
  return {
    agents: (snapshot) => emit({ agents: snapshot.agents, roots: snapshot.roots }),
    matrix: (snapshot, agent) =>
      emit(
        agent === null
          ? snapshot.skills
          : snapshot.skills.map((skill) => ({
              ...skill,
              cells: skill.cells.filter((cell) => cell.agent === agent),
            })),
      ),
    scan: (snapshot) => emit(snapshot.entries),
    status: (snapshot) => emit({ problems: snapshot.problems }),
    projects: (snapshot) =>
      emit({
        projects: snapshot.projects,
        entries: snapshot.entries.filter((entry) => entry.project !== null),
      }),
    plan: (plan) => emit({ plan }),
    planError: (error) => emit({ error }),
    inputError: (field, message) => emit({ error: { kind: "badInput", field, message } }),
    applied: (plan, outcome) => emit({ plan, outcome }),
  };
}

const GLYPH = {
  ok: "●",
  missing: "○",
  repair: "◐",
  extra: "−",
  blocked: "!",
  conflict: "✗",
  unmanaged: "?",
  untouched: "~",
  off: "·",
} as const satisfies Record<Verdict | "off", string>;

export function textRender(print: Print, printError: Print, home: string): Render {
  const tilde = (path: string) =>
    path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  const library = (skill: string) => tilde(`${home}/.gandalf/skills/${skill}`);
  const table = (rows: readonly (readonly string[])[], indent = "") => {
    const widths = rows[0]?.map((_, column) =>
      Math.max(...rows.map((row) => row[column]?.length ?? 0)),
    );
    for (const row of rows) {
      print(
        indent +
          row
            .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
            .join("  ")
            .trimEnd(),
      );
    }
  };

  const source = (from: Materialize) =>
    from.kind === "local"
      ? tilde(from.path)
      : `${from.url}@${from.commit.slice(0, 12)}${from.subpath === null ? "" : `:${from.subpath}`}`;

  const step = (s: Step): [string, string] => {
    switch (s.kind) {
      case "unlink":
        return ["unlink", `${tilde(`${s.slot.root}/${s.slot.name}`)}  (link to ${s.skill})`];
      case "trashCopy":
      case "trashProjectCopy":
        return ["trash", `${tilde(`${s.slot.root}/${s.slot.name}`)}  (gandalf's copy)`];
      case "libraryReplace":
        return ["update", `${library(s.skill)} from ${source(s.from)}`];
      case "commitState":
        return ["record", s.changes.map((c) => change(c, tilde)).join("; ")];
      case "ensureDir":
        return ["mkdir", tilde(s.dir)];
      case "libraryAdd":
        return ["add", `${library(s.skill)} from ${source(s.from)}`];
      case "adoptMove":
        return ["move", `${tilde(s.from.path)} -> ${library(s.skill)}`];
      case "trashDuplicate":
        return ["trash", `${tilde(s.from.path)}  (identical to ${s.skill})`];
      case "link":
        return ["link", `${tilde(`${s.slot.root}/${s.slot.name}`)} -> ${library(s.skill)}`];
      case "copy":
      case "projectCopy":
        return ["copy", `${tilde(`${s.slot.root}/${s.slot.name}`)} <- ${library(s.skill)}`];
      case "libraryTrash":
        return ["trash", library(s.skill)];
    }
  };

  const notDone = (item: Exclude<NotDone, { kind: "needsChoice" }>): [string, string] => {
    switch (item.kind) {
      case "conflict":
        return [
          "conflict",
          `${tilde(item.entry.path)}  ${observed(item.entry.observed)} already uses this name; gandalf never replaces it`,
        ];
      case "libraryMissing":
        return ["missing", `${item.skill}: its library dir is gone`];
      case "differsFromLibrary":
        return ["differs", `${tilde(item.at.path)}  differs from ${item.name}; left as is`];
      case "locallyModified":
        return ["modified", `${item.skill}: the library dir was edited; not updating it`];
      case "rootUnreadable":
        return ["unreadable", `${tilde(item.root)}: ${item.error}`];
    }
  };

  const printPlan = (plan: Plan) => {
    if (plan.steps.length > 0) table(plan.steps.map(step), "  ");
    else if (plan.notDone.length === 0) print("nothing to do");
    const choices = plan.notDone.filter((item) => item.kind === "needsChoice");
    const rest = plan.notDone.filter((item) => item.kind !== "needsChoice");
    if (rest.length > 0) {
      print("not doing");
      table(rest.map(notDone), "  ");
    }
    for (const choice of choices) {
      print(`${choice.name} differs between agents. Pick one:`);
      table(
        choice.variants.map((variant) => [
          variant.hash,
          variant.at.map((at) => tilde(at.path)).join(", "),
        ]),
        "  ",
      );
      print(`  gandalf skills adopt ${choice.name} --pick <hash>   (or --from <agent>)`);
    }
  };

  const result = (r: StepResult): string[] => {
    const [verb, detail] = step(r.step);
    const status = r.status === "alreadyDone" ? "already" : r.status;
    const why =
      r.status === "drifted"
        ? `  (found ${r.found})`
        : r.status === "failed"
          ? `  (${r.reason}: ${r.error})`
          : r.status === "skipped"
            ? `  (after step ${r.after + 1})`
            : "";
    return [status, verb, detail + why];
  };

  return {
    agents: (snapshot) => {
      table(
        snapshot.agents.map((agent) => [
          agent.id,
          agent.displayName,
          agent.installed ? "installed" : "-",
          tilde(agent.skillsDir),
          agent.mode,
          agent.readError ?? "",
        ]),
      );
      const shared = snapshot.roots.filter((root) => root.readers.length > 1);
      for (const root of shared)
        print(`shared: ${tilde(root.path)} read by ${root.readers.join(", ")}`);
    },
    matrix: (snapshot, agent) => {
      const agents = snapshot.agents
        .filter((a) => a.installed && a.readError === null && (agent === null || a.id === agent))
        .map((a) => a.id);
      if (snapshot.skills.length === 0) {
        print("the library is empty");
        return;
      }
      table([
        ["skill", ...agents],
        ...snapshot.skills.map((skill) => [
          skill.name,
          ...agents.map(
            (id) => GLYPH[skill.cells.find((cell) => cell.agent === id)?.verdict ?? "off"],
          ),
        ]),
      ]);
      print(
        Object.entries(GLYPH)
          .map(([verdict, glyph]) => `${glyph} ${verdict}`)
          .join("  "),
      );
    },
    scan: (snapshot) => {
      if (snapshot.roots.length === 0) print("no installed agents found");
      for (const root of snapshot.roots) {
        const entries = snapshot.entries.filter((entry) => entry.root === root.path);
        print(`${tilde(root.path)}  (${root.role}, read by ${root.readers.join(", ")})`);
        if (entries.length === 0) print("  (empty)");
        table(
          entries.map((entry) => [entry.name, verdictOf(entry), observed(entry.observed)]),
          "  ",
        );
      }
    },
    status: (snapshot) => {
      if (snapshot.problems.length === 0) {
        print("clean");
        return;
      }
      table(
        snapshot.problems.map((problem) =>
          problem.kind === "libraryMissing"
            ? [problem.kind, problem.skill, "tracked, but its library dir is gone"]
            : [
                problem.kind,
                tilde(problem.entry.path),
                `${verdictOf(problem.entry)}: ${observed(problem.entry.observed)}`,
              ],
        ),
      );
    },
    projects: (snapshot) => {
      if (snapshot.projects.length === 0) {
        print("no projects; gandalf projects add <path> registers one");
        return;
      }
      for (const project of snapshot.projects) {
        print(`${tilde(project.path)}  (${project.agents.join(", ") || "no agents"})`);
        if (project.readError !== null) print(`  ${project.readError}`);
        if (project.skills.length === 0) {
          print("  no skills yet");
          continue;
        }
        const verdict = (skill: string, agent: AgentId) => {
          const root = snapshot.roots.find(
            (candidate) => candidate.project === project.path && candidate.targets.includes(agent),
          );
          const entry = snapshot.entries.find(
            (candidate) => candidate.root === root?.path && candidate.name === skill,
          );
          return GLYPH[entry?.verdict ?? "off"];
        };
        table(
          [
            ["skill", ...project.agents],
            ...project.skills.map((skill) => [
              skill,
              ...project.agents.map((agent) => verdict(skill, agent)),
            ]),
          ],
          "  ",
        );
      }
    },
    plan: (plan, dryRun) => {
      printPlan(plan);
      if (dryRun && plan.steps.length > 0) print("dry run: nothing was written");
    },
    planError: (error) => printError(`gandalf: ${planError(error)}`),
    inputError: (_field, message) => printError(`gandalf: ${message}`),
    applied: (plan, outcome) => {
      switch (outcome.kind) {
        case "busy":
          print(
            `another gandalf (pid ${outcome.holder.pid}) has been applying since ${outcome.holder.since}`,
          );
          return;
        case "stale":
          print("disk changed since the preview; nothing was written. The plan now is:");
          if (outcome.fresh.ok) printPlan(outcome.fresh.plan);
          else print(`gandalf: ${planError(outcome.fresh.error)}`);
          return;
        case "applied": {
          table(outcome.results.map(result), "  ");
          const count = (status: StepResult["status"]) =>
            outcome.results.filter((r) => r.status === status).length;
          print(
            `${count("done")} done, ${count("alreadyDone")} already done, ${count("drifted")} drifted, ${count("failed")} failed, ${count("skipped")} skipped`,
          );
          const rest = plan.notDone.filter((item) => item.kind !== "needsChoice");
          if (rest.length > 0) {
            print("not done");
            table(rest.map(notDone), "  ");
          }
        }
      }
    },
  };
}

function verdictOf(entry: Entry): string {
  if (entry.verdict === "repair" || entry.verdict === "untouched") {
    return `${entry.verdict} (${entry.why})`;
  }
  return entry.verdict;
}

function observed(found: Observed): string {
  switch (found.kind) {
    case "absent":
      return "nothing";
    case "link":
      return found.resolves ? `link to ${found.skill}` : `broken link to ${found.skill}`;
    case "cleanCopy":
      return `gandalf's copy of ${found.skill}`;
    case "modifiedCopy":
      return `edited copy of ${found.skill}`;
    case "skillDir":
      return "a skill dir that is not gandalf's";
    case "foreignLink":
      return `${found.resolves ? "" : "broken "}link to ${found.target}`;
    case "other":
      return "not a skill";
  }
}

function enabled(enablement: Enablement): string {
  if (enablement.default) {
    return enablement.except.length === 0
      ? "all agents"
      : `all agents except ${enablement.except.join(", ")}`;
  }
  return enablement.except.length === 0 ? "no agents" : enablement.except.join(", ");
}

function change(c: StateChange, tilde: (path: string) => string): string {
  switch (c.kind) {
    case "track":
      return `track ${c.skill} for ${enabled(c.enabled)}`;
    case "untrack":
      return `untrack ${c.skill}`;
    case "setEnabled":
      return `${c.skill} on ${enabled(c.enabled)}`;
    case "setSource":
      return `${c.skill} source ${c.source.kind === "git" ? c.source.commit.slice(0, 12) : c.source.kind}`;
    case "setAgent":
      return `${c.agent} dir ${c.skillsDir ?? "default"}, mode ${c.mode ?? "auto"}`;
    case "setProject":
      return `project ${tilde(c.project)} for ${c.agents.join(", ") || "no agents"}`;
    case "untrackProject":
      return `forget project ${tilde(c.project)}`;
    case "setProjectSkill":
      return `${c.skill} ${c.enabled ? "on" : "off"} in ${tilde(c.project)}`;
    case "recordCopy":
      return `copy at ${tilde(c.path)}`;
    case "forgetCopy":
      return `no copy at ${tilde(c.path)}`;
  }
}

export function planError(error: PlanError): string {
  switch (error.kind) {
    case "unknownSkill":
      return `unknown skill ${error.skill}`;
    case "agentNotInstalled":
      return `${error.agent} is not installed`;
    case "nameTaken":
      return `the library already has a different skill named ${error.skill}`;
    case "nothingToAdopt":
      return `no unmanaged skill named ${error.name} to adopt`;
    case "notGitSourced":
      return `${error.skill} was not installed from git`;
    case "badSource":
      return `bad source: ${error.reason}`;
    case "unknownProject":
      return `${error.path} is not a registered project`;
    case "noProjectDir":
      return `gandalf knows of no project skills dir for ${error.agent}`;
    case "projectOverlaps":
      return `${error.dir}, ${error.agent}'s skills dir in ${error.path}, is already an agent's skills dir under HOME`;
  }
}
