#!/usr/bin/env node
import { openGandalf, nodeEnv, StateCorruptError } from "@gandalf/skills";
import { buildProgram } from "./program.js";

const env = nodeEnv();
const program = buildProgram({
  gandalf: openGandalf(env),
  home: env.home,
  cwd: process.cwd(),
  print: (line) => process.stdout.write(`${line}\n`),
  printError: (line) => process.stderr.write(`${line}\n`),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof StateCorruptError)) throw error;
  process.stderr.write(`gandalf: ${error.message}\n`);
  process.exitCode = 1;
}
