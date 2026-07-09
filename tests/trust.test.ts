import fs from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cursorTrustMarkerExists, seedClaudeTrust, seedCodexTrust, seedCursorTrust } from "../src/trust.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "arena-trust-"));
  tempDirs.push(home);
  return home;
}

describe("seedClaudeTrust", () => {
  it("adds a trusted project entry while preserving existing config", async () => {
    const home = await makeHome();
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", projects: { "/existing": { hasTrustDialogAccepted: false, custom: 1 } } }),
      "utf8"
    );

    const outcome = seedClaudeTrust("/tmp/ws-a", home);
    expect(outcome.seeded).toBe(true);

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.projects["/existing"]).toEqual({ hasTrustDialogAccepted: false, custom: 1 });
    expect(config.projects["/tmp/ws-a"].hasTrustDialogAccepted).toBe(true);
  });

  it("upgrades an existing untrusted entry without dropping its fields", async () => {
    const home = await makeHome();
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects: { "/tmp/ws-a": { hasTrustDialogAccepted: false, allowedTools: ["x"] } } }),
      "utf8"
    );

    seedClaudeTrust("/tmp/ws-a", home);

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.projects["/tmp/ws-a"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
  });

  it("creates the config when missing and reports failure on corrupt JSON", async () => {
    const home = await makeHome();
    expect(seedClaudeTrust("/tmp/ws-a", home).seeded).toBe(true);
    expect(existsSync(path.join(home, ".claude.json"))).toBe(true);

    writeFileSync(path.join(home, ".claude.json"), "not json", "utf8");
    const outcome = seedClaudeTrust("/tmp/ws-b", home);
    expect(outcome.seeded).toBe(false);
    expect(outcome.detail).toMatch(/could not update/);
  });
});

describe("seedCodexTrust", () => {
  it("appends a trusted project block without touching existing content", async () => {
    const home = await makeHome();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "config.toml"), `model = "gpt-5.6-sol"\n`, "utf8");

    const outcome = seedCodexTrust("/tmp/ws-a", home);
    expect(outcome.seeded).toBe(true);

    const text = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(text).toContain(`model = "gpt-5.6-sol"`);
    expect(text).toContain(`[projects."/tmp/ws-a"]`);
    expect(text).toContain(`trust_level = "trusted"`);
  });

  it("is idempotent and creates the file when missing", async () => {
    const home = await makeHome();
    expect(seedCodexTrust("/tmp/ws-a", home).seeded).toBe(true);
    expect(seedCodexTrust("/tmp/ws-a", home).detail).toBe("already configured");

    const text = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(text.match(/\[projects\."\/tmp\/ws-a"\]/g)).toHaveLength(1);
  });
});

describe("cursor trust", () => {
  function writeMarker(home: string, slug: string, workspacePath: string): void {
    const dir = path.join(home, ".cursor", "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, ".workspace-trusted"),
      JSON.stringify({ trustedAt: "2026-07-09T00:00:00.000Z", workspacePath, trustMethod: "cli-flag" }),
      "utf8"
    );
  }

  it("finds markers by content, not directory name", async () => {
    const home = await makeHome();
    writeMarker(home, "some-hashed-slug-abc1234", "/tmp/ws-long/path");
    expect(cursorTrustMarkerExists("/tmp/ws-long/path", home)).toBe(true);
    expect(cursorTrustMarkerExists("/tmp/other", home)).toBe(false);
  });

  it("short-circuits when the workspace is already trusted", async () => {
    const home = await makeHome();
    writeMarker(home, "slug", "/tmp/ws-a");
    const outcome = await seedCursorTrust("/tmp/ws-a", { home, binary: "/nonexistent-binary" });
    expect(outcome).toEqual({ seeded: true, detail: "already trusted" });
  });

  it("reports failure when the binary cannot run and no marker appears", async () => {
    const home = await makeHome();
    const outcome = await seedCursorTrust(home, { home, binary: "/nonexistent-binary", timeoutMs: 1500, pollMs: 50 });
    expect(outcome.seeded).toBe(false);
  });
});
