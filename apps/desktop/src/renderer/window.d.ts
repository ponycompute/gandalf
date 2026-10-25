import type { GandalfApi } from "../shared/ipc";

declare global {
  interface Window {
    readonly gandalf: GandalfApi;
  }
}
