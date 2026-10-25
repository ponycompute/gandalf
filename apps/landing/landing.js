// The page's three moving parts: the hero's working library matrix, the beams from the library to
// every agent folder, and the CLI tabs. Everything reads fine without this script.

/* global document, ResizeObserver */

const GLYPH = { linked: "●", add: "○", remove: "−", off: "·" };
const WORD = { linked: "Linked", add: "Will add", remove: "Will remove", off: "Off" };

// --- Hero matrix -----------------------------------------------------------------------------

const AGENTS = ["Claude Code", "Cursor", "Codex", "Gemini CLI"];
const SKILLS = [
  ["pdf", [1, 1, 1, 1]],
  ["code-review", [1, 0, 1, 0]],
  ["release-notes", [1, 1, 1, 1]],
  ["test-writer", [1, 0, 1, 1]],
  ["sql-migrations", [1, 1, 0, 0]],
];

/** What is on disk, and what the checkboxes ask for. They differ until Sync. */
const disk = SKILLS.map(([, cells]) => cells.map(Boolean));
const want = disk.map((row) => [...row]);

const table = document.querySelector("[data-matrix] tbody");
const syncButton = document.querySelector("[data-sync]");
const pending = document.querySelector("[data-pending]");
const status = document.querySelector("[data-status]");

function cellState(row, col) {
  if (want[row][col] === disk[row][col]) return disk[row][col] ? "linked" : "off";
  return want[row][col] ? "add" : "remove";
}

function renderMatrix() {
  table.replaceChildren(
    ...SKILLS.map(([name], row) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = name;
      tr.append(th);
      AGENTS.forEach((agent, col) => {
        const state = cellState(row, col);
        const td = document.createElement("td");
        td.innerHTML = `
          <label class="cell" data-state="${state}">
            <input type="checkbox" ${want[row][col] ? "checked" : ""}
              aria-label="${name} for ${agent}" data-row="${row}" data-col="${col}" />
            <span class="cell-glyph" aria-hidden="true">${GLYPH[state]}</span>
            <span class="cell-word">${WORD[state]}</span>
          </label>`;
        tr.append(td);
      });
      return tr;
    }),
  );
  const changes = want.flat().filter((value, i) => value !== disk.flat()[i]).length;
  syncButton.disabled = changes === 0;
  syncButton.textContent = changes === 0 ? "Sync" : `Sync ${changes}`;
  pending.textContent = changes === 0 ? "Up to date" : `${changes} planned`;
  pending.dataset.planned = String(changes > 0);
}

table.addEventListener("change", (event) => {
  const { row, col } = event.target.dataset;
  want[row][col] = event.target.checked;
  renderMatrix();
  status.textContent = "Planned. Nothing changes on disk until you Sync.";
  table.querySelector(`[data-row="${row}"][data-col="${col}"]`).focus();
});

syncButton.addEventListener("click", () => {
  const changes = want.flat().filter((value, i) => value !== disk.flat()[i]).length;
  want.forEach((row, r) => row.forEach((value, c) => (disk[r][c] = value)));
  renderMatrix();
  status.textContent = `${changes} done, 0 already done, 0 drifted, 0 failed, 0 skipped`;
});

renderMatrix();

// --- Projection beams ------------------------------------------------------------------------

const projection = document.querySelector("[data-projection]");
const beams = document.querySelector("[data-beams]");
const source = document.querySelector("[data-source]");

function drawBeams() {
  const box = projection.getBoundingClientRect();
  const from = source.getBoundingClientRect();
  const x0 = from.right - box.left;
  const y0 = from.top + from.height / 2 - box.top;
  beams.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  beams.replaceChildren();
  projection.querySelectorAll(".targets li").forEach((target, i) => {
    const to = target.getBoundingClientRect();
    const x1 = to.left - box.left;
    const y1 = to.top + to.height / 2 - box.top;
    const bend = (x1 - x0) * 0.55;
    const d = `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}`;
    for (const kind of ["beam", "pulse"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", kind);
      if (kind === "pulse") path.style.animationDelay = `${(i * 0.23) % 3}s`;
      beams.append(path);
    }
  });
}

new ResizeObserver(drawBeams).observe(projection);

// --- CLI tabs --------------------------------------------------------------------------------

const span = (cls, text) => `<span class="${cls}">${text}</span>`;
const $ = span("t-prompt", "$");
const TERM = {
  list: [
    `${$} gandalf skills list`,
    `skill            cursor  claude_code  codex  gemini_cli`,
    `code-review      ${span("t-muted", "·")}       ${span("t-ok", "●")}            ${span("t-unmanaged", "?")}      ${span("t-muted", "·")}`,
    `frontend-design  ${span("t-muted", "·")}       ${span("t-muted", "·")}            ${span("t-muted", "·")}      ${span("t-ok", "●")}`,
    `pdf              ${span("t-ok", "●")}       ${span("t-ok", "●")}            ${span("t-muted", "·")}      ${span("t-muted", "·")}`,
    `release-notes    ${span("t-ok", "●")}       ${span("t-ok", "●")}            ${span("t-ok", "●")}      ${span("t-ok", "●")}`,
    `sql-helpers      ${span("t-conflict", "✗")}       ${span("t-muted", "·")}            ${span("t-muted", "·")}      ${span("t-muted", "·")}`,
  ],
  enable: [
    `${$} gandalf skills enable code-review --dry-run`,
    `  ${span("t-verb", "record")}  code-review on all agents`,
    `  ${span("t-verb", "link")}    ~/.cursor/skills/code-review -> ~/.gandalf/skills/code-review`,
    `  ${span("t-verb", "link")}    ~/.gemini/skills/code-review -> ~/.gandalf/skills/code-review`,
    `not doing`,
    `  ${span("t-conflict", "conflict")}  ~/.codex/skills/code-review  a skill dir that is not gandalf's`,
    `            already uses this name; gandalf never replaces it`,
    span("t-muted", "dry run: nothing was written"),
  ],
  adopt: [
    `${$} gandalf skills adopt --all`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "record")}  track pdf for cursor, claude_code`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "mkdir")}   ~/.gandalf/skills`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "move")}    ~/.claude/skills/pdf -> ~/.gandalf/skills/pdf`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "trash")}   ~/.cursor/skills/pdf  (identical to pdf)`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.claude/skills/pdf -> ~/.gandalf/skills/pdf`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.cursor/skills/pdf -> ~/.gandalf/skills/pdf`,
    `6 done, 0 already done, 0 drifted, 0 failed, 0 skipped`,
  ],
  install: [
    `${$} gandalf skills install ~/src/release-notes`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "record")}  track release-notes for all agents`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "add")}     ~/.gandalf/skills/release-notes from ~/src/release-notes`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.claude/skills/release-notes -> ~/.gandalf/skills/release-notes`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.codex/skills/release-notes -> ~/.gandalf/skills/release-notes`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.cursor/skills/release-notes -> ~/.gandalf/skills/release-notes`,
    `  ${span("t-ok", "done")}  ${span("t-verb", "link")}    ~/.gemini/skills/release-notes -> ~/.gandalf/skills/release-notes`,
    `6 done, 0 already done, 0 drifted, 0 failed, 0 skipped`,
  ],
  status: [
    `${$} gandalf status`,
    `conflict  ~/.cursor/skills/sql-helpers  conflict: broken link to ~/old/sql-helpers`,
  ],
};

const term = document.querySelector("[data-term]");
const tabs = document.querySelectorAll("[data-tab]");

function showTab(name) {
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  term.innerHTML = TERM[name].join("\n").replaceAll(" <- ", " &lt;- ");
}

for (const tab of tabs) tab.addEventListener("click", () => showTab(tab.dataset.tab));
showTab("list");
