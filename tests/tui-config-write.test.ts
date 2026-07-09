import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigIfChanged } from "../src/tui/index.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeConfigPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-config-write-"));
  tempDirs.push(dir);
  return path.join(dir, "arena.config.json");
}

describe("writeConfigIfChanged", () => {
  it("skips the write when the on-disk config is semantically identical", async () => {
    const configPath = await makeConfigPath();
    // Different key order and formatting than JSON.stringify(config, null, 2)
    // would produce; a byte-compare would wrongly rewrite this.
    await fs.writeFile(configPath, `{"goal":"Win.","baseRepo":"."}\n`, "utf8");
    const before = await fs.stat(configPath);

    await writeConfigIfChanged(configPath, { baseRepo: ".", goal: "Win." });

    const after = await fs.stat(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(configPath, "utf8")).toBe(`{"goal":"Win.","baseRepo":"."}\n`);
  });

  it("writes when the config actually changed", async () => {
    const configPath = await makeConfigPath();
    await fs.writeFile(configPath, `{"goal":"Old.","baseRepo":"."}\n`, "utf8");

    await writeConfigIfChanged(configPath, { baseRepo: ".", goal: "New." });

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ baseRepo: ".", goal: "New." });
  });

  it("writes when the file is missing or unparseable", async () => {
    const configPath = await makeConfigPath();

    await writeConfigIfChanged(configPath, { goal: "Win." });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ goal: "Win." });

    await fs.writeFile(configPath, "not json", "utf8");
    await writeConfigIfChanged(configPath, { goal: "Win." });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ goal: "Win." });
  });
});
