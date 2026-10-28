#!/usr/bin/env node
// Node 22 calls node:sqlite, where gandalf records intent, experimental and says so on stderr on every
// run. Only that warning is dropped, and before anything loads the module; every other one shows.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const [kind] = rest;
  const type = typeof kind === "string" ? kind : (kind as { type?: unknown } | undefined)?.type;
  if (type === "ExperimentalWarning" && text.startsWith("SQLite")) return;
  Reflect.apply(emitWarning, process, [warning, ...rest]);
}) as typeof process.emitWarning;

await import("./main.js");
