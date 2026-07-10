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
  model?: string;
  timeoutMs?: number;
  pollMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function seedCursorTrust(workspace: string, options: CursorSeedOptions = {}): Promise<SeedOutcome> {
  const home = options.home ?? os.homedir();
  const binary = options.binary ?? "cursor-agent";
  // Uncontended the marker lands in ~1s, but a concurrent cursor process (the
  // preflight model probe runs right before this) can delay it, so allow ample
  // headroom.
  const timeoutMs = options.timeoutMs ?? 45000;
  const pollMs = options.pollMs ?? 200;

  if (cursorTrustMarkerExists(workspace, home)) {
    return { seeded: true, detail: "already trusted" };
  }

  // `-p --trust <prompt>` trusts the cwd and runs the prompt in print mode. A
  // REAL (inert) prompt is required: an empty prompt makes cursor write a
  // partial, hashed project dir and never record trust for git worktrees (the
  // arena's workspaces). Passing the agent's model avoids a default-model
  // surprise on accounts without one.
  const args = ["-p", "--trust", ...(options.model ? ["--model", options.model] : []), "arena trust check"];
  let child;
  try {
    child = spawn(binary, args, {
      cwd: workspace,
      stdio: "ignore",
      detached: false
    });
  } catch (error) {
    return { seeded: false, detail: `could not spawn ${binary}: ${(error as Error).message}` };
  }

  let spawnError: Error | undefined;
  let exitCode: number | null | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("exit", (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      // Fast path: the marker appears while the prompt is still running, so we
      // can kill the process early (trust is already persisted to disk).
      if (cursorTrustMarkerExists(workspace, home)) {
        return { seeded: true, detail: `trusted via ${binary} --trust` };
      }
      if (spawnError) {
        return { seeded: false, detail: `could not run ${binary}: ${spawnError.message}` };
      }
      // Fallback: under contention the marker check can lag, but a clean exit
      // in --trust print mode means trust was recorded before the prompt ran.
      if (exitCode !== undefined) {
        if (exitCode === 0 || cursorTrustMarkerExists(workspace, home)) {
          return { seeded: true, detail: `trusted via ${binary} --trust` };
        }
        return { seeded: false, detail: `${binary} exited ${exitCode ?? "unknown"} without recording trust` };
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
      outcome = await seedCursorTrust(agent.workspace, { ...options.cursor, home, binary: agent.binary, model: agent.model });
    } else {
      outcome = { seeded: false, detail: `no trust seeding for preset ${agent.preset}` };
    }
    results.push({ agentId: agent.id, preset: agent.preset, workspace: agent.workspace, ...outcome });
  }

  return results;
}

// Removes the trust entries seeded for a workspace. Called when a run is
// cleaned so ephemeral worktree paths don't accumulate forever in each CLI's
// trust store. Best-effort and never throws.
export function untrustWorkspace(workspace: string, home = os.homedir()): void {
  // Claude: drop the projects entry.
  try {
    const configPath = path.join(home, ".claude.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const projects = config.projects as Record<string, unknown> | undefined;
      if (projects && workspace in projects) {
        delete projects[workspace];
        atomicWrite(configPath, JSON.stringify(config, null, 2));
      }
    }
  } catch {
    // Leave it.
  }

  // Codex: strip the [projects."<workspace>"] block (header + trust_level line,
  // plus a leading blank line if present).
  try {
    const configPath = path.join(home, ".codex", "config.toml");
    if (fs.existsSync(configPath)) {
      const text = fs.readFileSync(configPath, "utf8");
      const escaped = workspace.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const header = `[projects."${escaped}"]`;
      if (text.includes(header)) {
        const pattern = new RegExp(
          `\\n*${escapeRegExp(header)}\\n[ \\t]*trust_level[ \\t]*=[ \\t]*"trusted"[ \\t]*\\n?`,
          "g"
        );
        const next = text.replace(pattern, "\n");
        atomicWrite(configPath, next.replace(/\n{3,}/g, "\n\n"));
      }
    }
  } catch {
    // Leave it.
  }

  // Cursor: remove the project dir for this workspace. Match by the marker's
  // workspacePath when present, and also by the computed dir slug so partial
  // dirs from a failed/interrupted seed (no marker written) are cleaned too.
  try {
    const projectsDir = path.join(home, ".cursor", "projects");
    const resolved = path.resolve(workspace);
    const slug = cursorProjectSlug(workspace);
    for (const entry of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, entry);
      let matches = entry === slug;
      if (!matches) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".workspace-trusted"), "utf8")) as {
            workspacePath?: string;
          };
          matches = Boolean(parsed.workspacePath && path.resolve(parsed.workspacePath) === resolved);
        } catch {
          // No/unparseable marker: fall back to the slug match above.
        }
      }
      if (matches) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch {
    // Leave it.
  }
}

// Cursor derives a project dir name from the workspace path by replacing every
// run of non-alphanumerics with a dash (very long paths are truncated and get
// a hash suffix, which this does not reconstruct).
function cursorProjectSlug(workspace: string): string {
  return workspace.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
