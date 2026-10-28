// `gandalf` command wiring. Each command maps argv to a raw intent (writes) or a snapshot view
// (reads). There is no domain logic here: validation is parseIntent, planning and safety are the
// package's, and the CLI only chooses between printing a plan and applying it.

import { isAbsolute, resolve } from "node:path";
import { Command, Option } from "commander";
import { InputError, parseIntent, type Gandalf, type Intent } from "@gandalf/skills";
import { jsonRender, textRender, type Render } from "./render.js";

export interface CliDeps {
  readonly gandalf: Gandalf;
  readonly home: string;
  readonly cwd: string;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
}

interface WriteOptions {
  readonly dryRun?: boolean;
}

/** Exit codes: 0 done, 1 an error or a step that did not complete, 2 something needs attention. */
const ATTENTION = 2;
const FAILURE = 1;

export function buildProgram(deps: CliDeps): Command {
  const program = new Command("gandalf")
    .description("one skill library, projected into every coding agent")
    .option("--json", "print one JSON document instead of text");
  const render = (): Render =>
    program.opts<{ json?: boolean }>().json === true
      ? jsonRender(deps.print)
      : textRender(deps.print, deps.printError, deps.home);

  /**
   * plan, then print it with --dry-run or apply it. `--dry-run` and the Electron preview screen are
   * the same plan() call; apply() re-derives the plan, so what was printed is what runs or nothing does.
   */
  async function write(raw: unknown, options: WriteOptions): Promise<void> {
    let intent: Intent;
    try {
      intent = parseIntent(raw);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      render().inputError(error.field, error.message);
      deps.setExitCode(FAILURE);
      return;
    }
    const outcome = await deps.gandalf.plan(intent);
    if (!outcome.ok) {
      render().planError(outcome.error);
      deps.setExitCode(FAILURE);
      return;
    }
    const plan = outcome.plan;
    if (plan.notDone.some((item) => item.kind === "needsChoice")) deps.setExitCode(ATTENTION);
    if (options.dryRun === true || plan.steps.length === 0) {
      render().plan(plan, options.dryRun === true);
      return;
    }
    const applied = await deps.gandalf.apply(plan);
    render().applied(plan, applied);
    if (!completed(applied)) deps.setExitCode(FAILURE);
  }

  const dryRun = (command: Command) =>
    command.option("--dry-run", "print the plan without applying it");
  const agentsOption = (command: Command) =>
    command.option("--agent <id...>", "limit to these agents (default: all)");

  const agents = program.command("agents").description("detected agents and their skills dirs");
  agents
    .command("list", { isDefault: true })
    .description("list every known agent")
    .action(async () => render().agents(await deps.gandalf.snapshot()));
  dryRun(
    agents
      .command("configure <id>")
      .description("set an agent's skills dir and mode; options not given reset to the default")
      .option("--dir <path>", "skills dir to use instead of the built-in one")
      .addOption(
        new Option("--mode <mode>", "how skills are projected").choices(["auto", "link", "copy"]),
      ),
  ).action((id: string, options: WriteOptions & { dir?: string; mode?: string }) =>
    write(
      {
        kind: "configureAgent",
        agent: id,
        skillsDir: options.dir === undefined ? null : resolve(deps.cwd, options.dir),
        mode: options.mode ?? null,
      },
      options,
    ),
  );

  program
    .command("status")
    .description("drift: broken links, conflicts, edited copies, missing library dirs (exit 2)")
    .action(async () => {
      const snapshot = await deps.gandalf.snapshot();
      render().status(snapshot);
      if (snapshot.problems.length > 0) deps.setExitCode(ATTENTION);
    });

  const skills = program.command("skills").description("manage the skill library");

  skills
    .command("list")
    .description("the library x agents matrix")
    .option("--agent <id>", "show one agent's column")
    .action(async (options: { agent?: string }) => {
      const snapshot = await deps.gandalf.snapshot();
      const agent = snapshot.agents.find((a) => a.id === options.agent);
      if (options.agent !== undefined && agent === undefined) {
        render().inputError("agent", `unknown agent ${options.agent}`);
        deps.setExitCode(FAILURE);
        return;
      }
      render().matrix(snapshot, agent?.id ?? null);
    });

  skills
    .command("scan")
    .description("classify every entry in every agent dir")
    .action(async () => render().scan(await deps.gandalf.snapshot()));

  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    dryRun(
      agentsOption(
        skills
          .command(`${verb} <name>`)
          .description(`${verb} a skill`)
          .option("--project <path>", "in this registered project instead of the agents' own dirs"),
      ),
    ).action((name: string, options: WriteOptions & { agent?: string[]; project?: string }) => {
      if (options.project === undefined) {
        return write(
          { kind: "setEnabled", skill: name, enabled, agents: options.agent ?? "all" },
          options,
        );
      }
      if (options.agent !== undefined) {
        render().inputError(
          "agent",
          "--agent and --project do not combine; a project's skills go to all its agents",
        );
        deps.setExitCode(FAILURE);
        return;
      }
      return write(
        {
          kind: "setProjectSkills",
          project: resolve(deps.cwd, options.project),
          skills: [name],
          enabled,
        },
        options,
      );
    });
  }

  dryRun(
    skills.command("sync").description("make every agent dir match the recorded intent"),
  ).action((options: WriteOptions) => write({ kind: "sync", skills: "all" }, options));

  dryRun(
    skills
      .command("adopt [name]")
      .description("move an unmanaged skill into the library and link it back")
      .option("--all", "adopt every unmanaged skill whose copies agree")
      .option("--pick <hash>", "the version to keep when copies differ")
      .option("--from <agent>", "keep the version in this agent's dir when copies differ"),
  ).action(
    (
      name: string | undefined,
      options: WriteOptions & { all?: boolean; pick?: string; from?: string },
    ) => {
      if ((name === undefined) === (options.all !== true)) {
        render().inputError("name", "name one skill to adopt, or pass --all");
        deps.setExitCode(FAILURE);
        return;
      }
      const pick =
        name === undefined
          ? []
          : [
              ...(options.pick === undefined ? [] : [{ name, kind: "hash", hash: options.pick }]),
              ...(options.from === undefined ? [] : [{ name, kind: "agent", agent: options.from }]),
            ];
      return write({ kind: "adopt", names: name === undefined ? "all" : [name], pick }, options);
    },
  );

  dryRun(
    agentsOption(
      skills
        .command("install <source>")
        .description("add a skill from a local dir or a git URL")
        .option("--subpath <path>", "skill dir inside the repo or dir")
        .option("--skill <name>", "find the skill by name in the repo instead of --subpath")
        .option("--ref <ref>", "branch, tag, or commit to install"),
    ),
  ).action(
    (
      source: string,
      options: WriteOptions & { subpath?: string; skill?: string; ref?: string; agent?: string[] },
    ) =>
      write(
        {
          kind: "install",
          source: sourceSpec(source, options, deps.cwd),
          agents: options.agent ?? "all",
        },
        options,
      ),
  );

  dryRun(
    skills
      .command("update [name]")
      .description("bring git and folder skills up to date with their source"),
  ).action((name: string | undefined, options: WriteOptions) =>
    write({ kind: "update", skills: name === undefined ? "all" : [name], pins: [] }, options),
  );

  dryRun(
    skills.command("remove <name>").description("remove a skill from the library and every agent"),
  ).action((name: string, options: WriteOptions) =>
    write({ kind: "remove", skill: name }, options),
  );

  const projects = program
    .command("projects")
    .description("folders whose agents get their own skills, as copies next to the code");
  projects
    .command("list", { isDefault: true })
    .description("registered projects and their skills x agents")
    .action(async () => render().projects(await deps.gandalf.snapshot()));
  dryRun(
    projects
      .command("add <path>")
      .description("register a project, or change which agents it writes skills for")
      .option(
        "--agent <id...>",
        "agents to write skills for (default: the project's agents, else every installed one with a project dir)",
      ),
  ).action(async (path: string, options: WriteOptions & { agent?: string[] }) => {
    const at = resolve(deps.cwd, path);
    let agents: readonly string[] | undefined = options.agent;
    if (agents === undefined) {
      const snapshot = await deps.gandalf.snapshot();
      agents =
        snapshot.projects.find((project) => project.path === at)?.agents ??
        snapshot.agents
          .filter((agent) => agent.installed && agent.projectDir !== null)
          .map((agent) => agent.id);
    }
    return write({ kind: "configureProject", path: at, agents }, options);
  });
  dryRun(
    projects
      .command("remove <path>")
      .description("forget a project; the skills gandalf copied there stay, as the project's own"),
  ).action((path: string, options: WriteOptions) =>
    write({ kind: "removeProject", path: resolve(deps.cwd, path) }, options),
  );

  return program;
}

function completed(outcome: Awaited<ReturnType<Gandalf["apply"]>>): boolean {
  return (
    outcome.kind === "applied" &&
    outcome.results.every((r) => r.status === "done" || r.status === "alreadyDone")
  );
}

/**
 * URLs and scp-style addresses go to git as given. A path ending in .git is a local repo, made
 * absolute here because git runs in gandalf's cache. Anything else is a local skill dir.
 */
export function sourceSpec(
  source: string,
  options: { readonly subpath?: string; readonly skill?: string; readonly ref?: string },
  cwd: string,
): unknown {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/\s]+@[^/\s]+:/.test(source);
  if (url || source.endsWith(".git") || source.endsWith(".git/")) {
    return {
      kind: "git",
      url: url || isAbsolute(source) ? source : resolve(cwd, source),
      ref: options.ref ?? null,
      subpath: options.subpath ?? null,
      skill: options.skill ?? null,
      commit: null,
    };
  }
  const base = resolve(cwd, source);
  return {
    kind: "local",
    path: options.subpath === undefined ? base : resolve(base, options.subpath),
  };
}
