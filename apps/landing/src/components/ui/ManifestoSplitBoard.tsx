import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// ANSI Color Helpers
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  brand: "\x1b[38;2;255;95;106m",
  brandBold: "\x1b[1;38;2;255;95;106m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

export default function ManifestoSplitBoard() {
  const terminalRef = React.useRef<HTMLDivElement>(null);
  const termInstanceRef = React.useRef<Terminal | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);

  React.useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "bar",
      fontFamily: "'DM Mono', 'JetBrains Mono', 'Menlo', 'Monaco', monospace",
      fontSize: 12,
      lineHeight: 1.5,
      letterSpacing: 0,
      rows: 14,
      theme: {
        background: "#09090b",
        foreground: "#f4f4f5",
        cursor: "#ff5f6a",
        selectionBackground: "rgba(255, 95, 106, 0.3)",
        black: "#18181b",
        red: "#ff5f6a",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#f472b6",
        cyan: "#38bdf8",
        white: "#f4f4f5",
        brightRed: "#ff7a83",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightWhite: "#ffffff",
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

    // Render authentic gandalf check output in xterm
    term.writeln(`${C.brandBold}$ ${C.reset}gandalf check`);
    term.writeln(`Team Manifest: zero2one-backend (version: 1.0)`);
    term.writeln(`Target Agents: claude-code, codex, cursor`);
    term.writeln("");
    term.writeln(`${C.yellow}[DRIFT DETECTED]${C.reset} 2 skills out of sync:`);
    term.writeln(`  [1] [codex] skill: team-reviewer`);
    term.writeln(`      ${C.gray}target: ~/.codex/skills/team-reviewer${C.reset}`);
    term.writeln(`  [2] [cursor] skill: db-migrations`);
    term.writeln(`      ${C.gray}target: ~/.cursor/skills/db-migrations${C.reset}`);
    term.writeln("");
    term.writeln(`${C.gray}Run 'gandalf apply' to sync safely.${C.reset}`);

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
  }, []);

  return (
    <div className="proof-window">
      {/* macOS Header Bar */}
      <div className="proof-window__bar">
        <div className="proof-window__dots">
          <span className="dot dot--red" />
          <span className="dot dot--yellow" />
          <span className="dot dot--green" />
        </div>
      </div>

      {/* Split Grid: Left = gandalf.toml Editor, Right = xterm.js CLI */}
      <div className="proof-window__grid">
        {/* Left: gandalf.toml Editor Panel */}
        <div className="proof-panel proof-panel--manifest">
          <div className="proof-panel__head">
            <span className="proof-panel__tag">team manifest</span>
            <span className="proof-panel__file">gandalf.toml</span>
          </div>
          <div className="proof-panel__code">
            <pre>
              <code>
                <span className="text-zinc-500"># gandalf.toml (team manifest)</span>{"\n"}
                <span className="text-sky-400">version</span> = <span className="text-emerald-400">"1.0"</span>{"\n"}
                <span className="text-sky-400">agents</span>  = [<span className="text-emerald-400">"claude-code"</span>, <span className="text-emerald-400">"codex"</span>, <span className="text-emerald-400">"cursor"</span>]{"\n\n"}
                <span className="text-[#ff5f6a] font-semibold">[[skills]]</span>{"\n"}
                <span className="text-sky-400">name</span>   = <span className="text-emerald-400">"team-reviewer"</span>{"\n"}
                <span className="text-sky-400">source</span> = <span className="text-emerald-400">"./.gandalf/skills/team-reviewer"</span>{"\n\n"}
                <span className="text-[#ff5f6a] font-semibold">[[skills]]</span>{"\n"}
                <span className="text-sky-400">name</span>   = <span className="text-emerald-400">"db-migrations"</span>{"\n"}
                <span className="text-sky-400">source</span> = <span className="text-emerald-400">"./.gandalf/skills/db-migrations"</span>
              </code>
            </pre>
          </div>
        </div>

        {/* Right: xterm.js Terminal Panel */}
        <div className="proof-panel proof-panel--terminal">
          <div className="proof-panel__head">
            <span className="proof-panel__tag">local agent status</span>
            <span className="proof-panel__cmd">$ gandalf check</span>
          </div>
          <div className="proof-panel__xterm-body">
            <div ref={terminalRef} style={{ width: "100%", height: "260px" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
