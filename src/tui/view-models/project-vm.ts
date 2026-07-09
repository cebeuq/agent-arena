import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig } from "../../config.js";
import type { ArenaConfig } from "../../types.js";

export type ProjectSummary = {
  path: string;
  isGitRepo: boolean;
  defaultBranch?: string;
  dirty?: boolean;
  remotes: string[];
  arenaDir: string;
  runCount: number;
  activeWorkspaces: number;
};

function gitOutput(repoRoot: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

export async function loadProjectSummary(repoRoot: string | undefined): Promise<ProjectSummary | undefined> {
  if (!repoRoot) {
    return undefined;
  }

  const arenaDir = path.join(repoRoot, ".agent-arena");
  const branch =
    gitOutput(repoRoot, ["symbolic-ref", "--short", "HEAD"]) ??
    gitOutput(repoRoot, ["rev-parse", "--short", "HEAD"]) ??
    "unknown";
  const status = gitOutput(repoRoot, ["status", "--short"]);
  const remotesRaw = gitOutput(repoRoot, ["remote", "-v"]) ?? "";
  const remotes = [
    ...new Map(
      remotesRaw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, url] = line.split(/\s+/);
          return [name, url] as const;
        })
    ).entries()
  ].map(([name, url]) => `${name} (${url})`);

  let runCount = 0;
  let activeWorkspaces = 0;
  try {
    runCount = (await fs.readdir(path.join(arenaDir, "runs"))).length;
  } catch {
    runCount = 0;
  }
  try {
    activeWorkspaces = (await fs.readdir(path.join(arenaDir, "workspaces"))).length;
  } catch {
    activeWorkspaces = 0;
  }

  return {
    path: repoRoot,
    isGitRepo: true,
    defaultBranch: branch,
    dirty: Boolean(status),
    remotes,
    arenaDir,
    runCount,
    activeWorkspaces
  };
}

export async function findNearbyGitRepos(root: string, maxDepth = 2, limit = 25): Promise<string[]> {
  const found = new Set<string>();
  const ignored = new Set([".agent-arena", ".cache", ".codex", ".git", ".npm", ".openclaw", ".Trash", "Library", "node_modules"]);

  async function visit(dir: string, depth: number): Promise<void> {
    if (found.size >= limit || depth > maxDepth) {
      return;
    }

    try {
      await fs.access(path.join(dir, ".git"));
      found.add(dir);
      return;
    } catch {
      // Keep walking.
    }

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.size >= limit || !entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return [...found].sort((a, b) => a.localeCompare(b));
}

export async function loadExistingConfig(repoRoot: string): Promise<{
  existingConfig?: ArenaConfig;
  existingConfigError?: string;
}> {
  const configPath = path.join(repoRoot, "arena.config.json");
  try {
    await fs.access(configPath);
    return {
      existingConfig: await readConfig(configPath)
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    return {
      existingConfigError: `Could not read ${configPath}: ${err.message}`
    };
  }
}
