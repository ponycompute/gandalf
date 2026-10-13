import * as React from "react";
import { flushSync } from "react-dom";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import recorded from "../../data/terminal-sessions.json";

// One terminal for every terminal on the page. It is a real xterm.js emulator
// that replays output recorded from the gandalf CLI (scripts/record-terminal.sh)
// and lets visitors type the same commands themselves.

export type Step = { command: string; output: string; exitCode: number };
export type RecordedSession = keyof typeof recorded;
export type Session = {
  id: string;
  label: string;
  /** Recorded CLI session to replay. */
  recording?: RecordedSession;
  /** A command that is typed but not run, such as an install command. */
  typeOnly?: string;
};

type Props = {
  sessions: Session[];
  /** Directory shown in the prompt and title bar. */
  cwd?: string;
  rows?: number;
  fontSize?: number;
  /** Start when scrolled into view instead of on mount. */
  playWhenVisible?: boolean;
  interactive?: boolean;
  /** Shows a copy button for the active session's typeOnly command. */
  copyable?: boolean;
};

const RECORDED = recorded as Record<string, Step[]>;
const ALL_STEPS = Object.values(RECORDED).flat();

const ESC = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export default function Terminal({
  sessions,
  cwd = "~/acme/api",
  rows = 18,
  fontSize = 13,
  playWhenVisible = false,
  interactive = false,
  copyable = false,
}: Props) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<XTerm | null>(null);
  const busyRef = React.useRef(false);
  const inputRef = React.useRef("");
  const tokenRef = React.useRef(0);
  const [active, setActive] = React.useState(sessions[0].id);
  const [copied, setCopied] = React.useState(false);
  const pillName = React.useId().replace(/:/g, "");

  const dir = cwd.split("/").pop() || "~";
  const prompt = `dev@macbook ${dir} % `;

  const writePrompt = React.useCallback(() => {
    termRef.current?.write(`${ESC.bold}${prompt}${ESC.reset}`);
  }, [prompt]);

  const printStep = React.useCallback(async (step: Step, token: number) => {
    const term = termRef.current;
    if (!term) return;
    for (const line of step.output.split("\n")) {
      if (token !== tokenRef.current) return;
      term.writeln(line);
      await sleep(16);
    }
  }, []);

  const play = React.useCallback(
    async (session: Session) => {
      const term = termRef.current;
      if (!term) return;
      const token = ++tokenRef.current;
      busyRef.current = true;
      inputRef.current = "";
      term.reset();
      writePrompt();

      const steps: Step[] = session.recording ? RECORDED[session.recording] : [];
      const commands = session.typeOnly ? [session.typeOnly] : steps.map((s) => s.command);

      for (let i = 0; i < commands.length; i++) {
        await sleep(i === 0 ? 300 : 700);
        for (const ch of commands[i]) {
          if (token !== tokenRef.current) return;
          term.write(ch);
          await sleep(22);
        }
        if (session.typeOnly) break;
        await sleep(250);
        term.write("\r\n");
        await printStep(steps[i], token);
        writePrompt();
      }

      if (token !== tokenRef.current) return;
      busyRef.current = false;
    },
    [printStep, writePrompt],
  );

  const select = React.useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id) ?? sessions[0];
      // Morph the active-tab pill to its new position with the View Transitions API.
      const update = () => flushSync(() => setActive(session.id));
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (document.startViewTransition && !reduce) document.startViewTransition(update);
      else update();
      void play(session);
    },
    [play, sessions],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Phones get a smaller font so recorded output wraps less.
    const size = window.matchMedia("(max-width: 720px)").matches ? Math.max(9.5, fontSize - 3) : fontSize;
    const term = new XTerm({
      rows,
      fontSize: size,
      lineHeight: 1.4,
      fontFamily: "'SF Mono', Menlo, monospace",
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: true,
      allowProposedApi: true,
      disableStdin: !interactive,
      scrollback: 500,
      theme: {
        background: "#0c0c0b",
        foreground: "#e9e9e6",
        cursor: "#e9e9e6",
        cursorAccent: "#0c0c0b",
        selectionBackground: "rgba(233, 233, 230, 0.25)",
        red: "#ff7b72",
        green: "#7ee2a8",
        yellow: "#f5c76b",
        blue: "#8ec5ff",
        brightBlack: "#8a8a85",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(host);
    termRef.current = term;

    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    };
    refit();

    // xterm measures glyphs once, so switch to the web font after it loads.
    document.fonts.load(`${size}px 'Geist Mono Variable'`).then(() => {
      term.options.fontFamily = "'Geist Mono Variable', 'SF Mono', Menlo, monospace";
      refit();
    });

    const runTyped = async (raw: string) => {
      const input = raw.trim();
      term.write("\r\n");
      if (!input) return writePrompt();
      if (input === "clear") {
        term.reset();
        return writePrompt();
      }
      const normalized = input.replace(/\s+/g, " ");
      const alias: Record<string, string> = {
        gandalf: "gandalf",
        "gandalf skill list": "gandalf",
        "gandalf help": "gandalf --help",
        "gandalf -h": "gandalf --help",
      };
      const wanted = alias[normalized] ?? normalized;
      const words = wanted.split(" ");
      const step =
        ALL_STEPS.find((s) => s.command === wanted) ??
        ALL_STEPS.find((s) => words.length >= 3 && s.command.split(" ").slice(0, 3).join(" ") === words.slice(0, 3).join(" "));
      if (words[0] !== "gandalf") {
        term.writeln(`zsh: command not found: ${words[0]}`);
      } else if (step) {
        busyRef.current = true;
        await printStep(step, tokenRef.current);
        busyRef.current = false;
      } else {
        term.writeln("This demo knows gandalf, gandalf skill sync|show|add|remove, and gandalf --help.");
      }
      writePrompt();
    };

    const onData = term.onData((data) => {
      if (!interactive || busyRef.current) return;
      if (data === "\r") {
        const line = inputRef.current;
        inputRef.current = "";
        void runTyped(line);
      } else if (data === "\x7f") {
        if (inputRef.current) {
          inputRef.current = inputRef.current.slice(0, -1);
          term.write("\b \b");
        }
      } else if (data === "\x03") {
        inputRef.current = "";
        term.write("^C\r\n");
        writePrompt();
      } else if (data >= " " && !data.startsWith("\x1b")) {
        inputRef.current += data;
        term.write(data);
      }
    });

    const resize = new ResizeObserver(refit);
    resize.observe(host);

    let io: IntersectionObserver | undefined;
    if (playWhenVisible) {
      io = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          io?.disconnect();
          void play(sessions[0]);
        },
        { threshold: 0.4 },
      );
      io.observe(host);
    } else {
      void play(sessions[0]);
    }

    return () => {
      tokenRef.current++;
      io?.disconnect();
      resize.disconnect();
      onData.dispose();
      term.dispose();
    };
    // The terminal is created once; sessions and settings are static per instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = sessions.find((s) => s.id === active) ?? sessions[0];

  const copy = async () => {
    if (!activeSession.typeOnly) return;
    try {
      await navigator.clipboard.writeText(activeSession.typeOnly);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="term">
      <div className="term__titlebar">
        <span className="term__lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term__title">{dir} — zsh</span>
        {copyable && activeSession.typeOnly && (
          <button type="button" className="term__copy" onClick={copy} aria-label="Copy command">
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {sessions.length > 1 && (
        <div className="term__tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((session) => {
            const isActive = session.id === active;
            return (
              <button
                key={session.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`term__tab${isActive ? " is-active" : ""}`}
                onClick={() => select(session.id)}
              >
                {isActive && (
                  <span className="term__tab-pill" style={{ viewTransitionName: `tab-${pillName}` }} aria-hidden="true" />
                )}
                {session.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="term__screen" onClick={() => termRef.current?.focus()}>
        <div ref={hostRef} className="term__host" />
      </div>
    </div>
  );
}
