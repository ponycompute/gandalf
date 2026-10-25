import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { Snapshot } from "@gandalf/skills";
import { HOME_ARGUMENT, channels, type GandalfApi, type Result } from "../shared/ipc";

const home = process.argv.find((arg) => arg.startsWith(HOME_ARGUMENT))?.slice(HOME_ARGUMENT.length);
if (home === undefined) throw new Error(`main passed no ${HOME_ARGUMENT} argument`);

const api = {
  home,
  snapshot: () => ipcRenderer.invoke(channels.snapshot),
  plan: (intent) => ipcRenderer.invoke(channels.plan, intent),
  apply: (token) => ipcRenderer.invoke(channels.apply, token),
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
