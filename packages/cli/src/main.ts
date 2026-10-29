import { openCapture } from "@gandalf/capture";
import { openGandalf, nodeEnv, StateCorruptError } from "@gandalf/skills";
import { buildProgram } from "./program.js";

// A reader that stops early, as `gandalf sessions | head` does, closes the pipe; that ends the
// output, and is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(process.exitCode ?? 0);
});

const env = nodeEnv();
const program = buildProgram({
  gandalf: openGandalf(env),
  capture: openCapture(env.home),
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
