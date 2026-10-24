import { expect, it } from "vitest";
import { VERSION } from "./index.js";

it("builds and runs", () => {
  expect(VERSION).toBe("0.0.0");
});
