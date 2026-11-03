import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DiagnosticReport,
  isCleanDiagnosticReport,
} from "./effect-diagnostics.js";
const clean = {
  diagnostics: [],
  summary: {
    filesChecked: 1,
    totalFiles: 1,
    errors: 0,
    warnings: 0,
    messages: 0,
  },
};
const report = (input: unknown) =>
  Schema.decodeUnknownSync(DiagnosticReport)(JSON.stringify(input));
describe("Effect report gate boundary", () => {
  it("accepts a complete clean report", () => {
    expect(isCleanDiagnosticReport(report(clean))).toBe(true);
  });
  it("rejects each diagnostic severity even when locations were not serialized", () => {
    for (const severity of ["errors", "warnings", "messages"] as const) {
      expect(
        isCleanDiagnosticReport(
          report({ ...clean, summary: { ...clean.summary, [severity]: 1 } }),
        ),
      ).toBe(false);
    }
  });
  it("rejects empty and partially checked projects", () => {
    for (const summary of [
      { ...clean.summary, filesChecked: 0, totalFiles: 0 },
      { ...clean.summary, totalFiles: 2 },
    ])
      expect(isCleanDiagnosticReport(report({ ...clean, summary }))).toBe(
        false,
      );
  });
  it("fails closed on malformed, missing or mistyped JSON fields", () => {
    for (const input of [
      "not-json",
      "{}",
      JSON.stringify({
        ...clean,
        summary: { ...clean.summary, messages: "0" },
      }),
      JSON.stringify({ ...clean, summary: { ...clean.summary, errors: -1 } }),
    ])
      expect(Schema.decodeUnknownEither(DiagnosticReport)(input)._tag).toBe(
        "Left",
      );
  });
});
