import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS_CSS, TOKENS_JSON, tokensCss } from "./tokens";

describe("tokens.css", () => {
  it("equals a fresh generation from design/tokens.json", () => {
    const fresh = tokensCss(JSON.parse(readFileSync(TOKENS_JSON, "utf8")));
    expect(readFileSync(TOKENS_CSS, "utf8")).toBe(fresh);
  });
});
