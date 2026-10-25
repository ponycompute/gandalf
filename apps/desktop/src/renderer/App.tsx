import { useEffect, useState, type ReactNode } from "react";
import type { Snapshot } from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";
import { Banner } from "./design/Banner";
import { Button } from "./design/Button";
import { SourceList } from "./design/SourceList";
import { Capsule, Toolbar } from "./design/Toolbar";
import { Window } from "./design/Window";
import { SCREENS, type Screen } from "./screens";

export type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: Snapshot }
  | { readonly kind: "failed"; readonly error: AppError };

function loadOf(result: Result<Snapshot>): Load {
  return result.ok
    ? { kind: "ready", snapshot: result.value }
    : { kind: "failed", error: result.error };
}

function useSnapshot(): Load {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    let pushArrived = false;
    const unsubscribe = window.gandalf.onSnapshot((result) => {
      pushArrived = true;
      setLoad(loadOf(result));
    });
    window.gandalf.snapshot().then(
      (result) => {
        if (!pushArrived) setLoad(loadOf(result));
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!pushArrived) setLoad({ kind: "failed", error: { kind: "internal", message } });
      },
    );
    return unsubscribe;
  }, []);
  return load;
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return focused;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function countLine(snapshot: Snapshot): string {
  const agents = snapshot.agents.filter((agent) => agent.installed && agent.readError === null);
  return `${plural(snapshot.skills.length, "skill")} in ${plural(agents.length, "agent")}`;
}

function LibraryPane({ snapshot }: { readonly snapshot: Snapshot }) {
  if (snapshot.skills.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 pb-toolbar-height text-center">
        <p className="text-large-title">The library is empty.</p>
        <p className="text-label-secondary">
          Install a skill, or adopt one you placed in an agent's folder from Discover.
        </p>
      </div>
    );
  }
  return (
    <ul aria-label="Skills">
      {snapshot.skills.map((skill) => (
        <li key={skill.name} className="flex h-row-height items-center gap-2 px-5 even:bg-row-alt">
          <span className="font-semibold">{skill.name}</span>
          <span className="min-w-0 truncate text-callout text-label-secondary">
            {skill.description}
          </span>
        </li>
      ))}
    </ul>
  );
}

const PANES = {
  library: LibraryPane,
  agents: () => null,
  discover: () => null,
  install: () => null,
} as const satisfies Record<Screen, (props: { readonly snapshot: Snapshot }) => ReactNode>;

function ErrorBanner({ error }: { readonly error: AppError }) {
  switch (error.kind) {
    case "stateCorrupt":
      return (
        <Banner tone="error" title="gandalf cannot read its state file">
          <span className="font-mono text-path break-all select-text">{error.path}</span>
          <span className="select-text">{error.reason}</span>
          <span>
            Fix the file or move it aside, then reopen gandalf. Until then gandalf changes no skills
            or agent folders.
          </span>
        </Banner>
      );
    case "git":
      return (
        <Banner tone="error" title="A git command failed">
          <span className="select-text">{error.message}</span>
          <span>
            Some changes may already be applied. Show Changes to see what is left, then Sync again.
          </span>
        </Banner>
      );
    case "badInput":
      return (
        <Banner tone="error" title="gandalf rejected the request">
          <span className="select-text">{error.message}</span>
          <span>Nothing changed. Fix the request, then try again.</span>
        </Banner>
      );
    case "internal":
      return (
        <Banner tone="error" title="gandalf hit an unexpected error">
          <span className="select-text">{error.message}</span>
          <span>Quit and reopen gandalf. If it happens again, report the message above.</span>
        </Banner>
      );
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>("library");
  const load = useSnapshot();
  const windowFocused = useWindowFocused();
  const Pane = PANES[screen];
  return (
    <Window
      sidebar={<SourceList current={screen} windowFocused={windowFocused} onSelect={setScreen} />}
      toolbar={
        <Toolbar
          title={SCREENS[screen].title}
          subtitle={load.kind === "ready" ? countLine(load.snapshot) : null}
        >
          <Capsule>
            <Button variant="primary" size="capsule" disabled>
              Sync
            </Button>
          </Capsule>
        </Toolbar>
      }
    >
      {load.kind === "failed" ? (
        <div className="p-5">
          <ErrorBanner error={load.error} />
        </div>
      ) : null}
      {load.kind === "ready" ? <Pane snapshot={load.snapshot} /> : null}
    </Window>
  );
}
