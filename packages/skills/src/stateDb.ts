// ~/.gandalf/state.db: recorded intent in SQLite, the store gandalf writes. What the intent holds,
// and why losing it can only make gandalf do less, is in state.ts.
//
// One table per kind of record, so later features can query intent where it lies. Rows are read
// back through parseState, the same boundary parse as state.json, so both stores accept and
// normalize exactly the same intent. A commit replaces every row in one transaction: the state is
// small, and replacing it keeps the meaning of a commit that of applyChanges, which both stores
// share.
//
// The default rollback journal, not WAL: a read-only open then creates nothing beside the database,
// so a read writes nothing, and Bun's node:sqlite can read it as well as Node's.
//
// Until the first commit there is no database, and the store reads the state.json an older gandalf
// left. The first commit moves that intent into the database, then moves state.json to the trash.

import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { Fs, Layout } from "./env.js";
import { canonicalJson } from "./json.js";
import {
  StateCorruptError,
  applyChanges,
  isNoop,
  parseState,
  readState,
  type CommitOutcome,
  type DesiredState,
  type StateStore,
} from "./state.js";
import type { AbsPath, Revision, SkillName } from "./types.js";

/** PRAGMA user_version. 0 is a database no commit has finished creating. */
const SCHEMA = 1;

const TABLES = `
CREATE TABLE revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;
CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (json_valid(source)),
  installed_at TEXT NOT NULL,
  enabled_default INTEGER NOT NULL CHECK (enabled_default IN (0, 1))
) STRICT;
CREATE TABLE skill_exceptions (
  skill TEXT NOT NULL REFERENCES skills (name) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  PRIMARY KEY (skill, agent)
) STRICT;
CREATE TABLE agents (
  agent TEXT PRIMARY KEY,
  skills_dir TEXT,
  mode TEXT CHECK (mode IN ('auto', 'link', 'copy'))
) STRICT;
CREATE TABLE projects (path TEXT PRIMARY KEY) STRICT;
CREATE TABLE project_agents (
  project TEXT NOT NULL REFERENCES projects (path) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  PRIMARY KEY (project, agent)
) STRICT;
CREATE TABLE project_skills (
  project TEXT NOT NULL REFERENCES projects (path) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  PRIMARY KEY (project, skill)
) STRICT;
CREATE TABLE project_copies (
  path TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects (path) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  hash TEXT NOT NULL
) STRICT;
PRAGMA user_version = ${SCHEMA};
`;

/** Children first, so no delete leaves a row pointing at nothing. */
const CLEAR_ORDER = [
  "project_copies",
  "project_skills",
  "project_agents",
  "projects",
  "skill_exceptions",
  "skills",
  "agents",
];

/** How long a read or commit waits for another process's commit to finish. */
const BUSY_MS = 5000;

/** SQLITE_CORRUPT and SQLITE_NOTADB: the file is there but holds no database gandalf can read. */
const CORRUPT_CODES = new Set([11, 26]);

export function sqliteStateStore(fs: Fs, paths: Layout): StateStore {
  const location = paths.stateDb;
  return {
    location,
    read: async () => (await readDatabase(fs, paths)) ?? readState(fs, paths),
    commit: async (from, changes, now) => {
      // Read before anything is created, so an unreadable state.json leaves no database behind.
      const legacy = (await fs.lstat(location)) === null ? await readState(fs, paths) : null;
      await fs.mkdir(paths.gandalfDir);
      const outcome = await guarded(location, async () => {
        const db = open(location, false);
        try {
          db.exec("BEGIN IMMEDIATE");
          const version = schemaOf(db);
          const fresh = version === 0;
          if (fresh) db.exec(TABLES);
          const state = fresh ? (legacy ?? (await readState(fs, paths))) : readRows(db);
          const decided = decide(state, from, changes);
          if (decided.kind === "done") {
            writeRows(db, {
              ...applyChanges(state, changes, now),
              revision: (from + 1) as Revision,
            });
          } else if (fresh) {
            writeRows(db, state);
          }
          db.exec("COMMIT");
          return decided;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }
      });
      await retireJson(fs, paths);
      return outcome;
    },
  };
}

/** Replaces whatever state.db holds with `state`, creating it when missing. Caller holds the lock. */
export async function writeStateDb(fs: Fs, paths: Layout, state: DesiredState): Promise<void> {
  await fs.mkdir(paths.gandalfDir);
  const db = open(paths.stateDb, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    if (schemaOf(db) === 0) db.exec(TABLES);
    writeRows(db, state);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** null while there is no database a commit has finished creating. */
async function readDatabase(fs: Fs, paths: Layout): Promise<DesiredState | null> {
  if ((await fs.lstat(paths.stateDb)) === null) return null;
  return guarded(paths.stateDb, async () => {
    const db = open(paths.stateDb, true);
    try {
      return schemaOf(db) === 0 ? null : readRows(db);
    } finally {
      db.close();
    }
  });
}

function decide(
  state: DesiredState,
  from: Revision,
  changes: Parameters<StateStore["commit"]>[1],
): CommitOutcome {
  if (isNoop(state, changes)) return { kind: "alreadyDone" };
  if (state.revision !== from) return { kind: "moved", revision: state.revision };
  return { kind: "done" };
}

function open(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  if (!readOnly) db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function schemaOf(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > SCHEMA) throw new UnreadableRows(`unsupported schema ${version}`);
  return version;
}

/** Rows that are there but do not parse as intent. */
class UnreadableRows extends Error {}

/** A file that holds no database, or rows that do not parse, become StateCorruptError. */
async function guarded<T>(location: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StateCorruptError) throw error;
    const code = (error as { errcode?: unknown }).errcode;
    if (error instanceof UnreadableRows || (typeof code === "number" && CORRUPT_CODES.has(code))) {
      throw new StateCorruptError(location, (error as Error).message);
    }
    throw error;
  }
}

type Row = Record<string, SQLOutputValue>;

/** The rows, rebuilt in state.json's storage shape and parsed by the one boundary parse. */
function readRows(db: DatabaseSync): DesiredState {
  const rows = (sql: string) => db.prepare(sql).all() as Row[];
  const revision = db.prepare("SELECT value FROM revision WHERE id = 1").get()?.value ?? 0;
  const skills: Record<string, { source: unknown; installedAt: unknown; enabled: Enablement }> = {};
  for (const row of rows("SELECT name, source, installed_at, enabled_default FROM skills")) {
    skills[String(row.name)] = {
      source: parseJson(row.source),
      installedAt: row.installed_at,
      enabled: { default: row.enabled_default === 1, except: [] },
    };
  }
  for (const row of rows("SELECT skill, agent FROM skill_exceptions")) {
    skills[String(row.skill)]?.enabled.except.push(row.agent);
  }
  const agents: Record<string, unknown> = {};
  for (const row of rows("SELECT agent, skills_dir, mode FROM agents")) {
    agents[String(row.agent)] = { skillsDir: row.skills_dir, mode: row.mode };
  }
  const projects: Record<string, Project> = {};
  for (const row of rows("SELECT path FROM projects")) {
    projects[String(row.path)] = { agents: [], skills: [], copies: {} };
  }
  for (const row of rows("SELECT project, agent FROM project_agents")) {
    projects[String(row.project)]?.agents.push(row.agent);
  }
  for (const row of rows("SELECT project, skill FROM project_skills")) {
    projects[String(row.project)]?.skills.push(row.skill);
  }
  for (const row of rows("SELECT path, project, skill, hash FROM project_copies")) {
    const project = projects[String(row.project)];
    if (project !== undefined)
      project.copies[String(row.path)] = { skill: row.skill, hash: row.hash };
  }
  try {
    return parseState({ schema: 1, revision, skills, agents, projects });
  } catch (error) {
    throw new UnreadableRows(error instanceof Error ? error.message : "invalid");
  }
}

interface Enablement {
  readonly default: boolean;
  readonly except: unknown[];
}

interface Project {
  readonly agents: unknown[];
  readonly skills: unknown[];
  readonly copies: Record<string, unknown>;
}

function parseJson(raw: SQLOutputValue | undefined): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new UnreadableRows("a skill's source is not JSON");
  }
}

function writeRows(db: DatabaseSync, state: DesiredState): void {
  for (const table of CLEAR_ORDER) db.exec(`DELETE FROM ${table}`);
  const skill = db.prepare(
    "INSERT INTO skills (name, source, installed_at, enabled_default) VALUES (?, ?, ?, ?)",
  );
  const exception = db.prepare("INSERT INTO skill_exceptions (skill, agent) VALUES (?, ?)");
  for (const name of Object.keys(state.skills).sort() as SkillName[]) {
    const record = state.skills[name]!;
    skill.run(
      name,
      canonicalJson(record.source),
      record.installedAt,
      record.enabled.default ? 1 : 0,
    );
    for (const agent of record.enabled.except) exception.run(name, agent);
  }
  const agent = db.prepare("INSERT INTO agents (agent, skills_dir, mode) VALUES (?, ?, ?)");
  for (const [id, override] of Object.entries(state.agents)) {
    if (override !== undefined) agent.run(id, override.skillsDir, override.mode);
  }
  const project = db.prepare("INSERT INTO projects (path) VALUES (?)");
  const projectAgent = db.prepare("INSERT INTO project_agents (project, agent) VALUES (?, ?)");
  const projectSkill = db.prepare("INSERT INTO project_skills (project, skill) VALUES (?, ?)");
  const copy = db.prepare(
    "INSERT INTO project_copies (path, project, skill, hash) VALUES (?, ?, ?, ?)",
  );
  for (const path of Object.keys(state.projects).sort() as AbsPath[]) {
    const record = state.projects[path]!;
    project.run(path);
    for (const id of record.agents) projectAgent.run(path, id);
    for (const name of record.skills) projectSkill.run(path, name);
    for (const [at, placed] of Object.entries(record.copies)) {
      if (placed !== undefined) copy.run(at, path, placed.skill, placed.hash);
    }
  }
  db.prepare(
    "INSERT INTO revision (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value",
  ).run(state.revision);
}

/** Once the database holds the intent, an old state.json goes to the trash, never deleted. */
async function retireJson(fs: Fs, paths: Layout): Promise<void> {
  if ((await fs.lstat(paths.stateFile)) !== "file") return;
  await fs.mkdir(paths.trashDir);
  await fs.rename(paths.stateFile, paths.trash("state.json"));
}
