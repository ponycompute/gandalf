import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { Snapshot } from "@gandalf/skills";
import { channels, type GandalfApi, type Result } from "../shared/ipc";

const notImplemented = {
  ok: false,
  error: { kind: "internal", message: "not implemented" },
} as const;

const api = {
  snapshot: () => ipcRenderer.invoke(channels.snapshot),
  plan: () => Promise.resolve(notImplemented),
  apply: () => Promise.resolve(notImplemented),
  onSnapshot: (listener) => {
    const forward = (_event: IpcRendererEvent, result: Result<Snapshot>) => listener(result);
    ipcRenderer.on(channels.snapshotPushed, forward);
    return () => {
      ipcRenderer.removeListener(channels.snapshotPushed, forward);
    };
  },
} satisfies GandalfApi;

contextBridge.exposeInMainWorld("gandalf", api);

let reduceTransparency = false;

function showReduceTransparency(): void {
  // null while the preload runs before <html> exists; DOMContentLoaded applies the value then.
  document.documentElement?.toggleAttribute("data-reduce-transparency", reduceTransparency);
}

ipcRenderer.on(channels.reduceTransparency, (_event, on: boolean) => {
  reduceTransparency = on;
  showReduceTransparency();
});
ipcRenderer.send(channels.watchReduceTransparency);
window.addEventListener("DOMContentLoaded", showReduceTransparency);
