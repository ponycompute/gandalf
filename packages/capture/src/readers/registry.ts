import type { AgentId } from "@gandalf/skills";
import type { SessionReader } from "./reader.js";
import { claudeCode } from "./claudeCode.js";
import { copilotCli } from "./copilotCli.js";

/** Every agent whose sessions gandalf reads. Adding one is one entry. */
export const READERS: readonly SessionReader[] = [claudeCode, copilotCli];

/** The agents whose sessions gandalf reads, in registry order. */
export const SESSION_AGENTS: readonly AgentId[] = READERS.map((reader) => reader.agent);
