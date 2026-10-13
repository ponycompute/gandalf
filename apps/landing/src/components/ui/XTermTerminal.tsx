import * as React from "react";
import { flushSync } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// ANSI Color Helpers
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brand: "\x1b[38;2;255;95;106m",
  brandBold: "\x1b[1;38;2;255;95;106m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

interface CommandScenario {
  id: string;
  command: string;
  label: string;
  lines: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Authentic Gandalf CLI Outputs
const SCENARIOS: CommandScenario[] = [
  {
    id: "check",
    label: "check",
    command: "gandalf check",
    lines: [
      "Team manifest: acme-api (3 skills, 1 MCP server)",
      "",
      `${C.yellow}drift${C.reset}  codex   skill release-checklist  missing`,
      `${C.yellow}drift${C.reset}  cursor  skill team-reviewer      stale copy`,
      `${C.green}ok${C.reset}     claude-code                     in sync`,
      "",
      `${C.gray}2 items out of sync. Run 'gandalf apply' to fix.${C.reset}`,
    ],
  },
  {
    id: "apply",
    label: "apply",
    command: "gandalf apply --yes",
    lines: [
      `${C.gray}snapshot preapply-20261013-091204 saved${C.reset}`,
      "",
      "copy  release-checklist  ~/.codex/skills/release-checklist",
      "copy  team-reviewer      ~/.cursor/skills/team-reviewer",
      "",
      `${C.green}Applied 2 changes.${C.reset} Personal skills left untouched.`,
      `${C.gray}Undo with: gandalf restore --snapshot preapply-20261013-091204 --apply${C.reset}`,
    ],
  },
  {
    id: "export",
    label: "export",
    command: "gandalf export",
    lines: [
      "Scanning Claude Code, Codex, and Cursor...",
      "",
      "skill  team-reviewer      -> .gandalf/skills/team-reviewer/",
      "skill  release-checklist  -> .gandalf/skills/release-checklist/",
      "skill  db-migrations      -> .gandalf/skills/db-migrations/",
      "",
      "Wrote gandalf.toml. Commit it and open a PR.",
    ],
  },
  {
    id: "restore",
    label: "restore",
    command: "gandalf restore --snapshot preapply-20261013-091204 --apply",
    lines: [
      "Restoring 2 paths from preapply-20261013-091204",
      "",
      "restore  ~/.codex/skills/release-checklist",
      "restore  ~/.cursor/skills/team-reviewer",
      "",
      `${C.green}Done.${C.reset} Agents are back to where they were.`,
    ],
  },
];

export default function XTermTerminal() {
  const terminalRef = React.useRef<HTMLDivElement>(null);
  const termInstanceRef = React.useRef<Terminal | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);

  const [activeScenarioId, setActiveScenarioId] = React.useState<string>("check");
  const [isRunning, setIsRunning] = React.useState(false);

  const inputBufferRef = React.useRef("");
  const isRunningRef = React.useRef(false);
  isRunningRef.current = isRunning;

  const executeScenario = React.useCallback(async (scId: string) => {
    const term = termInstanceRef.current;
    if (!term || isRunningRef.current) return;

    const sc = SCENARIOS.find((s) => s.id === scId) ?? SCENARIOS[0];
    // Morph the active-tab pill to its new position with the View Transitions API.
    const selectTab = () => flushSync(() => setActiveScenarioId(sc.id));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !reduceMotion) {
      document.startViewTransition(selectTab);
    } else {
      selectTab();
    }
    setIsRunning(true);

    term.clear();
    term.write(`${C.brandBold}$ ${C.reset}`);

    // Type the command smoothly
    for (const char of sc.command) {
      term.write(char);
      await sleep(15);
    }
    term.writeln("");
    await sleep(60);

    // Stream lines without extra $ prompts
    for (const line of sc.lines) {
      term.writeln(line);
      await sleep(35);
    }

    term.scrollToTop();
    setIsRunning(false);
    inputBufferRef.current = "";
  }, []);

  // Initialize xterm.js
  React.useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: window.matchMedia("(max-width: 720px)").matches ? 10.5 : 13,
      lineHeight: 1.65,
      letterSpacing: 0,
      rows: 14,
      theme: {
        background: "#0c0c0b",
        foreground: "#e9e9e6",
        cursor: "#e9e9e6",
        selectionBackground: "rgba(255, 95, 106, 0.3)",
        black: "#18181b",
        red: "#ff5f6a",
        green: "#7ee2a8",
        yellow: "#f5c76b",
        blue: "#60a5fa",
        magenta: "#f472b6",
        cyan: "#38bdf8",
        white: "#f4f4f5",
        brightRed: "#ff7a83",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightWhite: "#ffffff",
        brightBlack: "#8a8a85",
      },
      convertEol: true,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    try {
      fitAddon.fit();
    } catch {
      /* ignore */
    }

    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    // xterm measures glyphs once; switch to the web font after it has loaded.
    document.fonts.load("13px 'Geist Mono Variable'").then(() => {
      term.options.fontFamily = "'Geist Mono Variable', 'SF Mono', 'Menlo', monospace";
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
    });

    // Handle User Keyboard Inputs
    term.onData(async (data) => {
      if (isRunningRef.current) return;

      // Enter key
      if (data === "\r") {
        const cmd = inputBufferRef.current.trim().toLowerCase();
        term.writeln("");

        if (!cmd) {
          term.write(`${C.brandBold}$ ${C.reset}`);
          return;
        }

        if (cmd === "clear") {
          term.clear();
          term.write(`${C.brandBold}$ ${C.reset}`);
          inputBufferRef.current = "";
          return;
        }

        if (cmd === "help") {
          term.writeln(`Gandalf CLI Commands:`);
          term.writeln(`  gandalf export   - Collect existing skills into .gandalf/skills/`);
          term.writeln(`  gandalf check    - Find missing or stale team skills per agent`);
          term.writeln(`  gandalf apply    - Install team skills into every agent`);
          term.writeln(`  gandalf restore  - Restore agent configs from snapshot`);
          term.writeln(`  clear            - Clear terminal screen`);
          term.write(`\r\n${C.brandBold}$ ${C.reset}`);
          inputBufferRef.current = "";
          return;
        }

        if (cmd.includes("apply")) {
          await executeScenario("apply");
        } else if (cmd.includes("check")) {
          await executeScenario("check");
        } else if (cmd.includes("export") || cmd.includes("init")) {
          await executeScenario("export");
        } else if (cmd.includes("restore")) {
          await executeScenario("restore");
        } else {
          term.writeln(`gandalf: command not found: '${cmd}'. Try 'apply', 'check', 'export', 'restore', or 'help'`);
          term.write(`\r\n${C.brandBold}$ ${C.reset}`);
          inputBufferRef.current = "";
        }
        return;
      }

      // Backspace
      if (data === "\u007f" || data === "\b") {
        if (inputBufferRef.current.length > 0) {
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          term.write("\b \b");
        }
        return;
      }

      // Tab auto-complete
      if (data === "\t") {
        const current = inputBufferRef.current.trim();
        const matches = ["apply", "check", "export", "restore", "help", "clear"].filter((c) =>
          c.startsWith(current)
        );
        if (matches.length === 1) {
          const completion = matches[0].slice(current.length);
          inputBufferRef.current += completion;
          term.write(completion);
        }
        return;
      }

      // Normal character input
      if (data >= " " && data <= "~") {
        inputBufferRef.current += data;
        term.write(data);
      }
    });

    // Run initial apply scenario
    executeScenario("check");

    // Handle Window Resize
    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, [executeScenario]);

  return (
    <div className="terminal-shell">
      <div className="terminal-shell__bar">
        <span className="terminal-shell__title">~/acme/api</span>
        <div className="terminal-tabs-list" role="tablist" aria-label="Example commands">
          {SCENARIOS.map((sc) => {
            const isActive = sc.id === activeScenarioId;
            return (
              <button
                key={sc.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => executeScenario(sc.id)}
                disabled={isRunning}
                className={`terminal-tab-trigger ${isActive ? "is-active" : ""}`}
              >
                {isActive && <span className="terminal-tab-pill" aria-hidden="true" />}
                gandalf {sc.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Real xterm.js Canvas Container */}
      <div className="xterm-container-wrapper">
        <div ref={terminalRef} className="xterm-target-screen" />
      </div>
    </div>
  );
}
