import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDES } from "../src/defaults.js";
import { isExcluded, refreshAllMirrors, refreshMirror } from "../src/mirror.js";
import { makeRunState } from "./helpers/state.js";

let tempDirs: string[] = [];

async function makeWritable(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      await fs.chmod(target, 0o755);
      for (const entry of await fs.readdir(target)) {
        await makeWritable(path.join(target, entry));
      }
    } else {
      await fs.chmod(target, 0o644);
    }
  } catch {
    // Best-effort cleanup helper.
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await makeWritable(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("rival mirrors", () => {
  it("matches default exclude patterns", () => {
    expect(isExcluded(".git/config", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded("node_modules/pkg/index.js", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded(".env.local", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded("src/index.ts", DEFAULT_EXCLUDES)).toBe(false);
  });

  it("copies allowed files and makes the mirror read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-mirror-"));
    tempDirs.push(root);
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");

    await fs.mkdir(path.join(source, "src"), { recursive: true });
    await fs.mkdir(path.join(source, ".git"), { recursive: true });
    await fs.mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(source, "src", "index.ts"), "export const ok = true;\n");
    await fs.writeFile(path.join(source, ".env"), "SECRET=1\n");
    await fs.writeFile(path.join(source, ".git", "config"), "[core]\n");
    await fs.writeFile(path.join(source, "node_modules", "pkg", "index.js"), "module.exports = {}\n");

    await refreshMirror(source, dest, DEFAULT_EXCLUDES);

    await expect(fs.readFile(path.join(dest, "src", "index.ts"), "utf8")).resolves.toContain("ok");
    await expect(fs.access(path.join(dest, ".env"))).rejects.toThrow();
    await expect(fs.access(path.join(dest, ".git", "config"))).rejects.toThrow();
    await expect(fs.access(path.join(dest, "node_modules", "pkg", "index.js"))).rejects.toThrow();

    const fileMode = (await fs.stat(path.join(dest, "src", "index.ts"))).mode & 0o777;
    const dirMode = (await fs.stat(dest)).mode & 0o777;
    expect(fileMode & 0o222).toBe(0);
    expect(dirMode & 0o222).toBe(0);
  });

  it("mirrors rivals for every agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-mirror-on-"));
    tempDirs.push(root);

    const state = makeRunState(root);
    for (const agent of state.agents) {
      await fs.mkdir(agent.workspace, { recursive: true });
      await fs.writeFile(path.join(agent.workspace, "work.txt"), `${agent.id}\n`);
      agent.rivalDirs = Object.fromEntries(
        state.agents
          .filter((candidate) => candidate.id !== agent.id)
          .map((candidate) => [candidate.id, path.join(agent.rivalsDir, candidate.id)])
      );
    }

    await refreshAllMirrors(state);

    const [first, second] = state.agents;
    await expect(
      fs.readFile(path.join(first.rivalDirs[second.id], "work.txt"), "utf8")
    ).resolves.toContain(second.id);
  });
});
