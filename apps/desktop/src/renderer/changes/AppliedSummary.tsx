import type { StepResult } from "@gandalf/skills";
import { summaryLine, type Names } from "../vocabulary";
import { unfinished } from "./results";

export function AppliedSummary({
  results,
  names,
}: {
  readonly results: readonly StepResult[];
  readonly names: Names;
}) {
  const lines = unfinished(results, names);
  return (
    <div className="px-5 py-2">
      <p className="text-callout text-label-secondary">{summaryLine(results)}</p>
      {lines.length === 0 ? null : (
        <ul aria-label="Did not finish" className="text-callout">
          {lines.map((line, index) => (
            <li key={index} className="select-text">
              <span className="font-semibold">{line.step}</span> {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
