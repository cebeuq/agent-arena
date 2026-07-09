import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sendChatMessage } from "./chat.js";
import type { RunAgent, RunState } from "./types.js";

export type ProposalStatus = "pending" | "applied" | "failed";

export type ProposalRecord = {
  id: string;
  teamId: string;
  fromAgentId: string;
  fromCodename: string;
  captainAgentId: string;
  title: string;
  summary: string;
  createdAt: string;
  patchPath: string;
  status: ProposalStatus;
  statusNote?: string;
  updatedAt?: string;
};

function proposalsDir(state: RunState): string {
  return path.join(state.runDir, "proposals");
}

function proposalsPath(state: RunState): string {
  return path.join(proposalsDir(state), "proposals.json");
}

export async function readProposalRecords(state: RunState): Promise<ProposalRecord[]> {
  try {
    return JSON.parse(await fs.readFile(proposalsPath(state), "utf8")) as ProposalRecord[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeProposalRecords(state: RunState, records: ProposalRecord[]): Promise<void> {
  await fs.mkdir(proposalsDir(state), { recursive: true });
  await fs.writeFile(proposalsPath(state), `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function runGit(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

const PATCH_PATHSPECS = [
  ".",
  ":(exclude).arena/**",
  ":(exclude).agent-arena/**",
  ":(exclude)node_modules/**",
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)*.pem",
  ":(exclude)*.key"
];

function textPatchForUntracked(workspace: string, relPath: string): string {
  const result = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", relPath], {
    cwd: workspace,
    encoding: "utf8"
  });
  const raw = result.stdout || "";
  return raw
    .replaceAll("a/dev/null", "/dev/null")
    .replaceAll(`b/${relPath}`, `b/${relPath}`);
}

function capturePatch(agent: RunAgent): string {
  const tracked = runGit(["diff", "--binary", "HEAD", "--", ...PATCH_PATHSPECS], agent.workspace).stdout;
  const untracked = runGit(["ls-files", "--others", "--exclude-standard", "--", ...PATCH_PATHSPECS], agent.workspace).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((relPath) => textPatchForUntracked(agent.workspace, relPath))
    .filter(Boolean)
    .join("\n");
  return [tracked, untracked].filter(Boolean).join("\n");
}

function proposalMarkdown(records: ProposalRecord[], teamId: string, forAgentId?: string): string {
  const filtered = records.filter((record) => record.teamId === teamId);
  return [
    "# Agent Arena Patch Proposals",
    "",
    ...(filtered.length > 0
      ? filtered.map((record) => {
          const marker = forAgentId === record.captainAgentId && record.status === "pending" ? " pending for captain" : "";
          return `- ${record.id}: ${record.title} from ${record.fromCodename} (${record.fromAgentId}) [${record.status}]${marker}\n  ${record.summary}\n  Patch: ${record.patchPath}`;
        })
      : ["- No proposals."]),
    ""
  ].join("\n");
}

export async function renderProposalArtifacts(state: RunState): Promise<void> {
  const records = await readProposalRecords(state);
  await Promise.all(
    state.agents.map(async (agent) => {
      const dir = path.join(path.dirname(agent.goalFile), "proposals");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "team.md"), `${proposalMarkdown(records, agent.teamId)}\n`, "utf8");
      await fs.writeFile(path.join(dir, "inbox.md"), `${proposalMarkdown(records, agent.teamId, agent.id)}\n`, "utf8");
    })
  );
}

export async function createProposal(
  state: RunState,
  options: {
    agentId: string;
    title: string;
    summary: string;
    now?: Date;
  }
): Promise<ProposalRecord> {
  const agent = state.agents.find((candidate) => candidate.id === options.agentId);
  if (!agent) {
    throw new Error(`Unknown agent ${options.agentId}.`);
  }
  if (agent.isCaptain) {
    throw new Error("Captains apply proposals; non-captain teammates create them.");
  }
  if (!options.title.trim()) {
    throw new Error("Proposal title cannot be empty.");
  }

  const patch = capturePatch(agent);
  if (!patch.trim()) {
    throw new Error("No diff found to propose.");
  }

  const now = options.now ?? new Date();
  const id = `${agent.teamId}-${now.getTime().toString(36)}-${agent.id}`;
  const patchPath = path.join(proposalsDir(state), `${id}.patch`);
  await fs.mkdir(proposalsDir(state), { recursive: true });
  await fs.writeFile(patchPath, patch, "utf8");

  const record: ProposalRecord = {
    id,
    teamId: agent.teamId,
    fromAgentId: agent.id,
    fromCodename: agent.codename,
    captainAgentId: agent.captainAgentId,
    title: options.title.trim(),
    summary: options.summary.trim(),
    createdAt: now.toISOString(),
    patchPath,
    status: "pending"
  };

  const records = await readProposalRecords(state);
  records.push(record);
  await writeProposalRecords(state, records);
  await renderProposalArtifacts(state);
  await sendChatMessage(state, {
    fromAgentId: agent.id,
    scope: "dm",
    toAgentId: agent.captainAgentId,
    message: `Patch proposal ${record.id}: ${record.title}`,
    now
  });
  return record;
}

export async function applyProposal(
  state: RunState,
  options: {
    agentId: string;
    proposalId: string;
    now?: Date;
  }
): Promise<ProposalRecord> {
  const agent = state.agents.find((candidate) => candidate.id === options.agentId);
  if (!agent) {
    throw new Error(`Unknown agent ${options.agentId}.`);
  }
  if (!agent.isCaptain) {
    throw new Error("Only the team captain can apply proposals.");
  }

  const records = await readProposalRecords(state);
  const record = records.find((candidate) => candidate.id === options.proposalId);
  if (!record) {
    throw new Error(`Unknown proposal ${options.proposalId}.`);
  }
  if (record.captainAgentId !== agent.id) {
    throw new Error(`Proposal ${options.proposalId} belongs to captain ${record.captainAgentId}.`);
  }

  const check = spawnSync("git", ["apply", "--3way", "--check", record.patchPath], {
    cwd: agent.workspace,
    encoding: "utf8"
  });
  if (check.status !== 0) {
    record.status = "failed";
    record.statusNote = check.stderr || "git apply --check failed.";
    record.updatedAt = (options.now ?? new Date()).toISOString();
    await writeProposalRecords(state, records);
    await renderProposalArtifacts(state);
    return record;
  }

  const result = spawnSync("git", ["apply", "--3way", record.patchPath], {
    cwd: agent.workspace,
    encoding: "utf8"
  });
  record.status = result.status === 0 ? "applied" : "failed";
  record.statusNote = result.status === 0 ? "Applied with git apply --3way." : result.stderr || "git apply failed.";
  record.updatedAt = (options.now ?? new Date()).toISOString();
  await writeProposalRecords(state, records);
  await renderProposalArtifacts(state);
  return record;
}

export async function proposalHistory(state: RunState, teamId?: string): Promise<string> {
  const records = await readProposalRecords(state);
  const filtered = teamId ? records.filter((record) => record.teamId === teamId) : records;
  return [
    "# Agent Arena Proposals",
    "",
    ...(filtered.length > 0
      ? filtered.map((record) => `- ${record.id}: ${record.title} [${record.status}] from ${record.fromCodename} (${record.fromAgentId})`)
      : ["- No proposals."]),
    ""
  ].join("\n");
}
