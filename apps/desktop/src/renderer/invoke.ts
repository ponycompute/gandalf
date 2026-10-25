import type { Result } from "../shared/ipc";

/** A rejected IPC call, such as a missing handler, becomes an internal error like any other. */
export async function invoke<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { kind: "internal", message } };
  }
}
