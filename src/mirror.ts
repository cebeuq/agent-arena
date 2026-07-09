import fs from "node:fs/promises";
import path from "node:path";
import type { RunState } from "./types.js";

function normalizeRelPath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

function basenameMatchesPattern(relPath: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) {
    return false;
  }
  return path.basename(relPath).endsWith(pattern.slice(1));
}

function simpleGlobMatches(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return false;
  }

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function isExcluded(relPath: string, patterns: string[]): boolean {
  const normalized = normalizeRelPath(relPath);

  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3);
      return normalized === base || normalized.startsWith(`${base}/`);
    }

    if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
      const segment = pattern.slice(3, -3);
      return normalized.split("/").includes(segment);
    }

    if (basenameMatchesPattern(normalized, pattern)) {
      return true;
    }

    if (simpleGlobMatches(normalized, pattern) || simpleGlobMatches(path.basename(normalized), pattern)) {
      return true;
    }

    return normalized === pattern || path.basename(normalized) === pattern;
  });
}

async function makeWritable(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      await fs.chmod(target, 0o755);
      const entries = await fs.readdir(target);
      await Promise.all(entries.map((entry) => makeWritable(path.join(target, entry))));
    } else {
      await fs.chmod(target, 0o644);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

async function makeReadOnly(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    await Promise.all(entries.map((entry) => makeReadOnly(path.join(target, entry))));
    await fs.chmod(target, 0o555);
  } else {
    await fs.chmod(target, 0o444);
  }
}

async function copyFiltered(source: string, dest: string, relPath: string, excludes: string[]): Promise<void> {
  const stat = await fs.lstat(source);
  if (relPath && isExcluded(relPath, excludes)) {
    return;
  }

  if (stat.isSymbolicLink()) {
    return;
  }

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(source);
    for (const entry of entries) {
      const childRel = relPath ? `${relPath}/${entry}` : entry;
      await copyFiltered(path.join(source, entry), path.join(dest, entry), childRel, excludes);
    }
    return;
  }

  if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
  }
}

export async function refreshMirror(source: string, dest: string, excludes: string[]): Promise<void> {
  await makeWritable(dest);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  await copyFiltered(source, dest, "", excludes);
  await makeReadOnly(dest);
}

export async function refreshAllMirrors(state: RunState): Promise<void> {
  for (const agent of state.agents) {
    for (const rival of state.agents) {
      if (rival.id === agent.id) {
        continue;
      }

      const rivalDir = agent.rivalDirs[rival.id];
      if (!rivalDir) {
        continue;
      }

      await refreshMirror(rival.workspace, rivalDir, state.peek.exclude);
    }
  }
}
