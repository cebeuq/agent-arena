import type { ChatMessage } from "../../chat.js";
import { USER_SENDER_ID } from "../../chat.js";
import type { ClaimRecord, RunAgent, RunState, RunTeam } from "../../types.js";
import type { RunSnapshot } from "./run-watcher.js";

export type AgentRunState = "working" | "claimed" | "winner" | "stopped";

export function runTeamsOf(state: RunState): RunTeam[] {
  if (state.teams && state.teams.length > 0) {
    return state.teams;
  }
  return state.agents.map((agent) => ({
    id: agent.teamId ?? agent.id,
    name: agent.teamName ?? agent.name,
    captainAgentId: agent.captainAgentId ?? agent.id,
    agentIds: [agent.id],
    resources: []
  }));
}

export function agentRunState(snapshot: RunSnapshot, agentId: string): AgentRunState {
  if (snapshot.state.winner?.agentId === agentId) {
    return "winner";
  }
  if (snapshot.state.status !== "running") {
    return "stopped";
  }
  if (snapshot.state.claims.some((claim) => claim.agentId === agentId && claim.status === "pending")) {
    return "claimed";
  }
  return "working";
}

export function messageVisibleToAgent(message: ChatMessage, agent: RunAgent): boolean {
  if (message.scope === "public") {
    return true;
  }
  if (message.scope === "team") {
    return message.teamId === agent.teamId;
  }
  return message.fromAgentId === agent.id || message.toAgentId === agent.id;
}

export function unreadCountForAgent(snapshot: RunSnapshot, agentId: string): number {
  const agent = snapshot.state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return 0;
  }
  const readIds = new Set(snapshot.reads[agentId] ?? []);
  return snapshot.messages.filter(
    (message) => message.fromAgentId !== agentId && messageVisibleToAgent(message, agent) && !readIds.has(message.id)
  ).length;
}

export function pendingClaims(snapshot: RunSnapshot): ClaimRecord[] {
  return snapshot.state.claims.filter((claim) => claim.status === "pending");
}

export type ChatThread = {
  id: string;
  kind: "public" | "team" | "dm";
  label: string;
  teamId?: string;
  agentId?: string;
  unread: number;
};

export function threadMessages(snapshot: RunSnapshot, thread: ChatThread): ChatMessage[] {
  if (thread.kind === "public") {
    return snapshot.messages.filter((message) => message.scope === "public");
  }
  if (thread.kind === "team") {
    return snapshot.messages.filter((message) => message.scope === "team" && message.teamId === thread.teamId);
  }
  return snapshot.messages.filter(
    (message) => message.scope === "dm" && (message.fromAgentId === thread.agentId || message.toAgentId === thread.agentId)
  );
}

function unreadForUser(snapshot: RunSnapshot, messages: ChatMessage[]): number {
  const readIds = new Set(snapshot.reads[USER_SENDER_ID] ?? []);
  return messages.filter((message) => message.fromAgentId !== USER_SENDER_ID && !readIds.has(message.id)).length;
}

export function buildThreads(snapshot: RunSnapshot): ChatThread[] {
  const threads: ChatThread[] = [];
  const publicThread: ChatThread = { id: "public", kind: "public", label: "Public", unread: 0 };
  publicThread.unread = unreadForUser(snapshot, threadMessages(snapshot, publicThread));
  threads.push(publicThread);

  for (const team of runTeamsOf(snapshot.state)) {
    const thread: ChatThread = { id: `team:${team.id}`, kind: "team", label: team.name, teamId: team.id, unread: 0 };
    thread.unread = unreadForUser(snapshot, threadMessages(snapshot, thread));
    threads.push(thread);
  }

  for (const agent of snapshot.state.agents) {
    const thread: ChatThread = {
      id: `dm:${agent.id}`,
      kind: "dm",
      label: `DM ${agent.codename ?? agent.name} (${agent.id})`,
      agentId: agent.id,
      unread: 0
    };
    thread.unread = unreadForUser(snapshot, threadMessages(snapshot, thread));
    threads.push(thread);
  }

  return threads;
}

export function unreadMessageIdsForUser(snapshot: RunSnapshot, thread: ChatThread): string[] {
  const readIds = new Set(snapshot.reads[USER_SENDER_ID] ?? []);
  return threadMessages(snapshot, thread)
    .filter((message) => message.fromAgentId !== USER_SENDER_ID && !readIds.has(message.id))
    .map((message) => message.id);
}

export type PatchSummary = {
  files: Array<{ path: string; additions: number; deletions: number }>;
  additions: number;
  deletions: number;
};

export function summarizePatch(patch: string): PatchSummary {
  const files: PatchSummary["files"] = [];
  let current: PatchSummary["files"][number] | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  };
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function elapsedLabel(snapshot: RunSnapshot, now: Date = new Date()): string {
  const start = new Date(snapshot.state.startedAt).getTime();
  const end = snapshot.state.finishedAt ? new Date(snapshot.state.finishedAt).getTime() : now.getTime();
  return formatElapsed(end - start);
}

// "Asked HH:MM" annotation for the judge view: the latest Director DM to the
// claimant that is newer than the claim itself.
export function askedForMoreAt(snapshot: RunSnapshot, claim: ClaimRecord): string | undefined {
  const claimedAt = new Date(claim.claimedAt).getTime();
  const question = [...snapshot.messages]
    .reverse()
    .find(
      (message) =>
        message.scope === "dm" &&
        message.fromAgentId === USER_SENDER_ID &&
        message.toAgentId === claim.agentId &&
        new Date(message.createdAt).getTime() >= claimedAt
    );
  return question?.createdAt;
}
