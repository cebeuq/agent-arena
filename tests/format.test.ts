import { describe, expect, it } from "vitest";
import { formatLocalTime, pluralize } from "../src/format.js";

describe("pluralize", () => {
  it("handles regular and irregular plurals", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(2, "file")).toBe("2 files");
    expect(pluralize(0, "warning")).toBe("0 warnings");
    expect(pluralize(1, "branch", "branches")).toBe("1 branch");
    expect(pluralize(3, "branch", "branches")).toBe("3 branches");
  });
});

describe("formatLocalTime", () => {
  it("renders ISO timestamps in local time", () => {
    const iso = "2026-07-09T20:38:36.210Z";
    const local = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(formatLocalTime(iso)).toBe(`${pad(local.getHours())}:${pad(local.getMinutes())}`);
    expect(formatLocalTime(iso, { seconds: true })).toBe(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`
    );
    expect(formatLocalTime(iso, { date: true })).toContain(`${local.getFullYear()}-`);
  });

  it("passes through unparseable input", () => {
    expect(formatLocalTime("not a date")).toBe("not a date");
  });
});
