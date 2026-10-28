import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { Snapshot } from "@gandalf/skills";
import {
  HOME_ARGUMENT,
  REAL_HOME_ARGUMENT,
  channels,
  type GandalfApi,
  type MenuCommand,
  type Result,
} from "../shared/ipc";

function argument(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const home = argument(HOME_ARGUMENT);
if (home === undefined) throw new Error(`main passed no ${HOME_ARGUMENT} argument`);
// Without it, home is taken as already free of symlinks.
const realHome = argument(REAL_HOME_ARGUMENT) ?? home;

const api = {
  home,
  realHome,
  snapshot: () => ipcRenderer.invoke(channels.snapshot),
  plan: (intent) => ipcRenderer.invoke(channels.plan, intent),
  apply: (token) => ipcRenderer.invoke(channels.apply, token),
  readSkillFile: (path) => ipcRenderer.invoke(channels.readSkillFile, path),
  cancelPlan: () => ipcRenderer.invoke(channels.cancelPlan),
  chooseFolder: () => ipcRenderer.invoke(channels.chooseFolder),
  revealSkill: (dir) => ipcRenderer.invoke(channels.revealSkill, dir),
  revealLibrary: () => ipcRenderer.invoke(channels.revealLibrary),
  revealProject: (path) => ipcRenderer.invoke(channels.revealProject, path),
  searchSkillsSh: (query) => ipcRenderer.invoke(channels.searchSkillsSh, query),
  repoSkills: (repository) => ipcRenderer.invoke(channels.repoSkills, repository),
  skillsShBoard: (board) => ipcRenderer.invoke(channels.skillsShBoard, board),
  ownerAvatar: (owner) => ipcRenderer.invoke(channels.ownerAvatar, owner),
  setAppearance: (appearance) => ipcRenderer.invoke(channels.setAppearance, appearance),
  setMenuState: (state) => ipcRenderer.send(channels.menuState, state),
  onMenuCommand: (listener) => {
    const forward = (_event: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on(channels.menuCommand, forward);
    return () => {
      ipcRenderer.removeListener(channels.menuCommand, forward);
    };
  },
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
