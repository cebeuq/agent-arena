import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunState } from "./types.js";
import { resolveGitRoot } from "./worktree.js";

type RunIndex = Record<string, string>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getIndexPath(): string {
  // AGENT_ARENA_HOME lets tests (and unusual setups) keep the run index away
  // from the user's real home directory.
  return path.join(process.env.AGENT_ARENA_HOME ?? os.homedir(), ".agent-arena", "runs.json");
}

async function readIndex(): Promise<RunIndex> {
  try {
    const raw = await fs.readFile(getIndexPath(), "utf8");
    return JSON.parse(raw) as RunIndex;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function registerRun(runId: string, statePath: string): Promise<void> {
  const index = await readIndex();
  index[runId] = statePath;
  await writeJsonAtomic(getIndexPath(), index);
}

export async function deregisterRun(runId: string): Promise<void> {
  const index = await readIndex();
  if (!(runId in index)) {
    return;
  }
  delete index[runId];
  await writeJsonAtomic(getIndexPath(), index);
}

export async function resolveStatePath(runId: string, explicitStatePath?: string): Promise<string> {
  if (explicitStatePath) {
    return path.resolve(explicitStatePath);
  }

  const index = await readIndex();
  const indexed = index[runId];
  if (indexed) {
    return indexed;
  }

  const localCandidate = path.resolve(".agent-arena", "runs", runId, "state.json");
  try {
    await fs.access(localCandidate);
    return localCandidate;
  } catch {
    throw new Error(`Unknown run ${runId}. Pass --state or run agent-arena status from the base repo.`);
  }
}

export type LocalRunState = {
  state: RunState;
  statePath: string;
};

// Lists runs from the current repo plus every run registered in the global
// index (~/.agent-arena/runs.json), so commands like `arena overseer` work
// from any directory. Entries whose state file is gone are skipped.
export async function listLocalRunStates(cwd = process.cwd()): Promise<LocalRunState[]> {
  let repoRoot = cwd;
  try {
    repoRoot = resolveGitRoot(cwd);
  } catch {
    repoRoot = cwd;
  }

  // Keyed by canonical path so the same state file reached via a symlinked
  // path (e.g. /tmp vs /private/tmp on macOS) is not listed twice; the
  // first-seen (repo-local) spelling of the path is preserved.
  const candidatePaths = new Map<string, string>();

  async function addCandidate(statePath: string): Promise<void> {
    const resolved = path.resolve(statePath);
    let canonical = resolved;
    try {
      canonical = await fs.realpath(resolved);
    } catch {
      // Missing files are skipped by the reader below anyway.
    }
    if (!candidatePaths.has(canonical)) {
      candidatePaths.set(canonical, resolved);
    }
  }

  const runsRoot = path.join(repoRoot, ".agent-arena", "runs");
  try {
    for (const runId of await fs.readdir(runsRoot)) {
      await addCandidate(path.resolve(runsRoot, runId, "state.json"));
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  for (const statePath of Object.values(await readIndex())) {
    await addCandidate(statePath);
  }

  return (
    await Promise.all(
      [...candidatePaths.values()].map(async (statePath) => {
        try {
          const state = await readRunState(statePath);
          return { state, statePath };
        } catch {
          return undefined;
        }
      })
    )
  ).filter((entry): entry is LocalRunState => Boolean(entry));
}

export async function resolveLatestLocalStatePath(cwd = process.cwd()): Promise<string> {
  const states = await listLocalRunStates(cwd);

  if (states.length === 0) {
    throw new Error("No readable local Agent Arena runs found. Pass --run or start a run first.");
  }

  const running = states.filter((entry) => entry.state.status === "running");
  if (running.length > 1) {
    const choices = running
      .sort((left, right) => right.state.startedAt.localeCompare(left.state.startedAt))
      .map((entry) => `- ${entry.state.runId}: ${entry.state.goal}`)
      .join("\n");
    throw new Error(`Multiple local runs are still running. Pass --run with one of:\n${choices}`);
  }
  if (running.length === 1) {
    return running[0].statePath;
  }

  return states.sort((left, right) => right.state.startedAt.localeCompare(left.state.startedAt))[0].statePath;
}

export async function readRunState(statePath: string): Promise<RunState> {
  const raw = await fs.readFile(statePath, "utf8");
  return JSON.parse(raw) as RunState;
}

function redactStateForPersistence(state: RunState): RunState {
  return {
    ...state,
    agents: state.agents.map((agent) => ({
      ...agent,
      env: agent.env
        ? Object.fromEntries(Object.keys(agent.env).map((key) => [key, "<redacted>"]))
        : undefined
    }))
  };
}

export async function writeRunState(state: RunState): Promise<void> {
  await writeJsonAtomic(state.statePath, redactStateForPersistence(state));
}

export async function withRunLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + 30000;
  let handle: fs.FileHandle | undefined;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST" || Date.now() > deadline) {
        throw error;
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}
