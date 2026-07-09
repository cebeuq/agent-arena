// Pre-trusts agent workspaces in each CLI's own trust store so the interactive
// trust-warmup session is normally unnecessary: fresh worktrees would otherwise
// greet every agent with a "do you trust this folder?" dialog and stall the
// race until a human answers it in every pane.
//
// Mechanisms (per CLI, discovered on real installs):
// - Claude Code: ~/.claude.json  projects["<dir>"].hasTrustDialogAccepted
// - Codex CLI:   ~/.codex/config.toml  [projects."<dir>"] trust_level = "trusted"
// - Cursor CLI:  no writable store with a stable path (the per-project dir name
//   hashes long paths), but `cursor-agent -p --trust ""` records trust for its
//   cwd at startup; we spawn it, poll ~/.cursor/projects/*/.workspace-trusted
//   for a marker whose content names the workspace, then kill the process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentPresetId, RunState } from "./types.js";

export type TrustSeedResult = {
  agentId: string;
  preset: AgentPresetId;
  workspace: string;
  seeded: boolean;
  detail: string;
};

export type SeedOutcome = { seeded: boolean; detail: string };

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.agent-arena-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

export function seedClaudeTrust(workspace: string, home = os.homedir()): SeedOutcome {
  const configPath = path.join(home, ".claude.json");
  try {
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    }
    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    const existing = projects[workspace];
    if (existing?.hasTrustDialogAccepted === true) {
      return { seeded: true, detail: "already trusted" };
    }
    projects[workspace] = { allowedTools: [], ...existing, hasTrustDialogAccepted: true };
    config.projects = projects;
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    return { seeded: true, detail: "trusted via ~/.claude.json" };
  } catch (error) {
    return { seeded: false, detail: `could not update ~/.claude.json: ${(error as Error).message}` };
  }
}

function tomlBasicString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function seedCodexTrust(workspace: string, home = os.homedir()): SeedOutcome {
  const configPath = path.join(home, ".codex", "config.toml");
  try {
    const header = `[projects.${tomlBasicString(workspace)}]`;
    let text = "";
    if (fs.existsSync(configPath)) {
      text = fs.readFileSync(configPath, "utf8");
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    if (text.includes(header)) {
      return { seeded: true, detail: "already configured" };
    }
    const block = `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}\n${header}\ntrust_level = "trusted"\n`;
    fs.appendFileSync(configPath, block, "utf8");
    return { seeded: true, detail: "trusted via ~/.codex/config.toml" };
  } catch (error) {
    return { seeded: false, detail: `could not update ~/.codex/config.toml: ${(error as Error).message}` };
  }
}

export function cursorTrustMarkerExists(workspace: string, home = os.homedir()): boolean {
  const projectsDir = path.join(home, ".cursor", "projects");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return false;
  }
  const resolved = path.resolve(workspace);
  for (const entry of entries) {
    const marker = path.join(projectsDir, entry, ".workspace-trusted");
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { workspacePath?: string };
      if (parsed.workspacePath && path.resolve(parsed.workspacePath) === resolved) {
        return true;
      }
    } catch {
      // Missing or unparseable marker: not trusted via this entry.
    }
  }
  return false;
}

export type CursorSeedOptions = {
  home?: string;
  binary?: string;
  timeoutMs?: number;
  pollMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function seedCursorTrust(workspace: string, options: CursorSeedOptions = {}): Promise<SeedOutcome> {
  const home = options.home ?? os.homedir();
  const binary = options.binary ?? "cursor-agent";
  const timeoutMs = options.timeoutMs ?? 20000;
  const pollMs = options.pollMs ?? 250;

  if (cursorTrustMarkerExists(workspace, home)) {
    return { seeded: true, detail: "already trusted" };
  }

  // `--trust` records trust for the cwd during CLI startup, before any model
  // work happens. The empty prompt keeps it from doing anything else; we kill
  // the process as soon as the marker appears.
  let child;
  try {
    child = spawn(binary, ["-p", "--trust", ""], {
      cwd: workspace,
      stdio: "ignore",
      detached: false
    });
  } catch (error) {
    return { seeded: false, detail: `could not spawn ${binary}: ${(error as Error).message}` };
  }

  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (cursorTrustMarkerExists(workspace, home)) {
        return { seeded: true, detail: `trusted via ${binary} --trust` };
      }
      if (spawnError) {
        return { seeded: false, detail: `could not run ${binary}: ${spawnError.message}` };
      }
      if (Date.now() >= deadline) {
        return { seeded: false, detail: `no trust marker after ${timeoutMs} ms` };
      }
      await sleep(pollMs);
    }
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

export type PreTrustOptions = {
  home?: string;
  cursor?: Omit<CursorSeedOptions, "home" | "binary">;
};

// Seeds trust for every preset agent's workspace. Custom-command agents have
// no CLI trust store and are skipped. Never throws: a failed seed simply means
// that agent still needs the interactive warmup.
export async function preTrustWorkspaces(state: RunState, options: PreTrustOptions = {}): Promise<TrustSeedResult[]> {
  const home = options.home ?? os.homedir();
  const results: TrustSeedResult[] = [];

  for (const agent of state.agents) {
    if (!agent.preset || !agent.binary) {
      continue;
    }
    let outcome: SeedOutcome;
    if (agent.preset === "claude") {
      outcome = seedClaudeTrust(agent.workspace, home);
    } else if (agent.preset === "codex") {
      outcome = seedCodexTrust(agent.workspace, home);
    } else if (agent.preset === "cursor") {
      outcome = await seedCursorTrust(agent.workspace, { ...options.cursor, home, binary: agent.binary });
    } else {
      outcome = { seeded: false, detail: `no trust seeding for preset ${agent.preset}` };
    }
    results.push({ agentId: agent.id, preset: agent.preset, workspace: agent.workspace, ...outcome });
  }

  return results;
}
