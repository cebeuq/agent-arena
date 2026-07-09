import fs from "node:fs/promises";
import path from "node:path";
import { sendTmuxPaneText } from "./tmux.js";
import type { AgentPresetId, RunAgent, RunState } from "./types.js";

export type ChatScope = "team" | "public" | "dm";

// The human director (overseer user) participates in chat under this reserved id.
export const USER_SENDER_ID = "user";
export const USER_SENDER_CODENAME = "Director";

export type ChatMessage = {
  id: string;
  createdAt: string;
  scope: ChatScope;
  fromAgentId: string;
  fromCodename: string;
  fromTeamId: string;
  toAgentId?: string;
  teamId?: string;
  message: string;
};

type ReadState = Record<string, string[]>;
type DeliveryState = Record<string, Record<string, { immediateSentAt?: string; reminderSentAt?: string }>>;
type NoticeSender = (paneId: string | undefined, message: string, preset?: AgentPresetId) => void;

const REMINDER_DELAY_MS = 2 * 60 * 1000;

function chatDir(state: RunState): string {
  return path.join(state.runDir, "chat");
}

function messagesPath(state: RunState): string {
  return path.join(chatDir(state), "messages.jsonl");
}

function readsPath(state: RunState): string {
  return path.join(chatDir(state), "reads.json");
}

function deliveryPath(state: RunState): string {
  return path.join(chatDir(state), "delivery.json");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function lineToMessage(line: string): ChatMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as ChatMessage;
  } catch {
    // A torn trailing line from a concurrent append; the next read sees it whole.
    return undefined;
  }
}

export async function readChatMessages(state: RunState): Promise<ChatMessage[]> {
  try {
    const raw = await fs.readFile(messagesPath(state), "utf8");
    return raw
      .split(/\r?\n/)
      .map(lineToMessage)
      .filter((message): message is ChatMessage => Boolean(message));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function appendMessage(state: RunState, message: ChatMessage): Promise<void> {
  await fs.mkdir(chatDir(state), { recursive: true });
  await fs.appendFile(messagesPath(state), `${JSON.stringify(message)}\n`, "utf8");
}

function agentLabel(agent: RunAgent | undefined): string {
  if (!agent) {
    return "unknown";
  }
  return `${agent.codename ?? agent.name} (${agent.id})`;
}

function recipientsForMessage(state: RunState, message: ChatMessage): RunAgent[] {
  if (message.scope === "public") {
    return state.agents.filter((agent) => agent.id !== message.fromAgentId);
  }
  if (message.scope === "team") {
    return state.agents.filter((agent) => agent.teamId === message.teamId && agent.id !== message.fromAgentId);
  }
  return state.agents.filter((agent) => agent.id === message.toAgentId && agent.id !== message.fromAgentId);
}

function visibleMessages(state: RunState, agent: RunAgent, messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (message.scope === "public") {
      return true;
    }
    if (message.scope === "team") {
      return message.teamId === agent.teamId;
    }
    return message.fromAgentId === agent.id || message.toAgentId === agent.id;
  });
}

function unreadMessages(messages: ChatMessage[], reads: ReadState, agent: RunAgent): ChatMessage[] {
  const readIds = new Set(reads[agent.id] ?? []);
  return messages.filter((message) => message.fromAgentId !== agent.id && !readIds.has(message.id));
}

function scopeNoun(scope: ChatScope): string {
  if (scope === "dm") {
    return "DM";
  }
  if (scope === "public") {
    return "public";
  }
  return "team";
}

function pendingNotice(messages: ChatMessage[]): string {
  const latest = messages[messages.length - 1];
  if (!latest) {
    return "";
  }
  const from = latest.fromCodename;
  const noun = scopeNoun(latest.scope);
  if (messages.length === 1) {
    return `ARENA CHAT: You have a pending ${noun} message from ${from}. Run ./.arena/chat.sh inbox`;
  }
  return `ARENA CHAT: You have ${messages.length} unread ${noun} messages, latest from ${from}. Run ./.arena/chat.sh inbox`;
}

function groupUnread(messages: ChatMessage[]): ChatMessage[][] {
  const groups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const key = `${message.scope}:${message.fromAgentId}`;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return [...groups.values()];
}

function renderMessage(message: ChatMessage): string {
  const target = message.scope === "dm" ? ` -> ${message.toAgentId}` : "";
  return `- ${message.createdAt} ${message.fromCodename} (${message.fromAgentId})${target}: ${message.message}`;
}

function renderHistory(title: string, messages: ChatMessage[]): string {
  return [`# ${title}`, "", ...(messages.length > 0 ? messages.map(renderMessage) : ["- No messages."]), ""].join("\n");
}

function renderInbox(agent: RunAgent, visible: ChatMessage[], reads: ReadState): string {
  const unread = unreadMessages(visible, reads, agent);
  return [
    "# Agent Arena Inbox",
    "",
    `Agent: ${agentLabel(agent)}`,
    `Unread: ${unread.length}`,
    "",
    "## Unread",
    "",
    ...(unread.length > 0 ? unread.map(renderMessage) : ["- No unread messages."]),
    "",
    "## Recent Visible Messages",
    "",
    ...(visible.slice(-25).length > 0 ? visible.slice(-25).map(renderMessage) : ["- No messages."]),
    ""
  ].join("\n");
}

export async function renderChatArtifacts(state: RunState): Promise<void> {
  const messages = await readChatMessages(state);
  const reads = await readJson<ReadState>(readsPath(state), {});

  await Promise.all(
    state.agents.map(async (agent) => {
      const dir = path.join(path.dirname(agent.goalFile), "chat");
      await fs.mkdir(dir, { recursive: true });
      const visible = visibleMessages(state, agent, messages);
      await fs.writeFile(
        path.join(dir, "team.md"),
        `${renderHistory(
          "Team Chat",
          messages.filter((message) => message.scope === "team" && message.teamId === agent.teamId)
        )}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(dir, "public.md"),
        `${renderHistory(
          "Public Chat",
          messages.filter((message) => message.scope === "public")
        )}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(dir, "dms.md"),
        `${renderHistory(
          "Direct Messages",
          messages.filter((message) => message.scope === "dm" && (message.fromAgentId === agent.id || message.toAgentId === agent.id))
        )}\n`,
        "utf8"
      );
      await fs.writeFile(path.join(dir, "inbox.md"), `${renderInbox(agent, visible, reads)}\n`, "utf8");
    })
  );
}

type ChatSender = {
  id: string;
  codename: string;
  teamId: string;
};

function resolveChatSender(state: RunState, fromAgentId: string, teamId?: string): ChatSender {
  if (fromAgentId === USER_SENDER_ID) {
    return {
      id: USER_SENDER_ID,
      codename: USER_SENDER_CODENAME,
      teamId: teamId ?? USER_SENDER_ID
    };
  }
  const agent = state.agents.find((candidate) => candidate.id === fromAgentId);
  if (!agent) {
    throw new Error(`Unknown sending agent ${fromAgentId}.`);
  }
  return {
    id: agent.id,
    codename: agent.codename ?? agent.name,
    teamId: agent.teamId
  };
}

export async function sendChatMessage(
  state: RunState,
  options: {
    fromAgentId: string;
    scope: ChatScope;
    message: string;
    toAgentId?: string;
    teamId?: string;
    now?: Date;
    sender?: NoticeSender;
  }
): Promise<ChatMessage> {
  const fromUser = options.fromAgentId === USER_SENDER_ID;
  const senderAgent = resolveChatSender(state, options.fromAgentId, options.teamId);
  if (!["team", "public", "dm"].includes(options.scope)) {
    throw new Error("Chat scope must be team, public, or dm.");
  }
  if (!options.message.trim()) {
    throw new Error("Chat message cannot be empty.");
  }
  if (options.scope === "team" && fromUser) {
    if (!options.teamId) {
      throw new Error("User team messages require --team <team-id>.");
    }
    if (!(state.teams ?? []).some((team) => team.id === options.teamId)) {
      throw new Error(`Unknown team ${options.teamId}.`);
    }
  }
  if (options.scope === "dm") {
    if (!options.toAgentId) {
      throw new Error("DM messages require --to <agent-id>.");
    }
    if (options.toAgentId === options.fromAgentId) {
      throw new Error("Agents cannot send DMs to themselves.");
    }
    if (options.toAgentId !== USER_SENDER_ID && !state.agents.some((agent) => agent.id === options.toAgentId)) {
      throw new Error(`Unknown DM recipient ${options.toAgentId}.`);
    }
  }

  const now = options.now ?? new Date();
  const message: ChatMessage = {
    id: `${now.getTime()}-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: now.toISOString(),
    scope: options.scope,
    fromAgentId: senderAgent.id,
    fromCodename: senderAgent.codename,
    fromTeamId: senderAgent.teamId,
    toAgentId: options.scope === "dm" ? options.toAgentId : undefined,
    teamId: options.scope === "team" ? (fromUser ? options.teamId : senderAgent.teamId) : undefined,
    message: options.message.trim()
  };

  await appendMessage(state, message);

  const delivery = await readJson<DeliveryState>(deliveryPath(state), {});
  delivery[message.id] = delivery[message.id] ?? {};
  const paneSender = options.sender ?? sendTmuxPaneText;
  for (const recipient of recipientsForMessage(state, message)) {
    delivery[message.id][recipient.id] = {
      ...delivery[message.id][recipient.id],
      immediateSentAt: now.toISOString()
    };
    paneSender(recipient.paneId, pendingNotice([message]), recipient.preset);
  }

  await writeJson(deliveryPath(state), delivery);
  await renderChatArtifacts(state);
  return message;
}

export async function readChatReadState(state: RunState): Promise<Record<string, string[]>> {
  return readJson<ReadState>(readsPath(state), {});
}

export async function markMessagesRead(state: RunState, readerId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }
  const reads = await readJson<ReadState>(readsPath(state), {});
  reads[readerId] = [...new Set([...(reads[readerId] ?? []), ...messageIds])];
  await writeJson(readsPath(state), reads);
}

export async function readInbox(state: RunState, agentId: string): Promise<ChatMessage[]> {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent ${agentId}.`);
  }

  const messages = await readChatMessages(state);
  const reads = await readJson<ReadState>(readsPath(state), {});
  const visible = visibleMessages(state, agent, messages);
  const unread = unreadMessages(visible, reads, agent);
  reads[agent.id] = [...new Set([...(reads[agent.id] ?? []), ...unread.map((message) => message.id)])];
  await writeJson(readsPath(state), reads);
  await renderChatArtifacts(state);
  return unread;
}

export async function chatHistory(
  state: RunState,
  options: {
    teamId?: string;
    publicOnly?: boolean;
    agentId?: string;
  }
): Promise<string> {
  const messages = await readChatMessages(state);
  if (options.publicOnly) {
    return renderHistory("Public Chat", messages.filter((message) => message.scope === "public"));
  }
  if (options.teamId) {
    return renderHistory("Team Chat", messages.filter((message) => message.scope === "team" && message.teamId === options.teamId));
  }
  if (options.agentId) {
    const agent = state.agents.find((candidate) => candidate.id === options.agentId);
    if (!agent) {
      throw new Error(`Unknown agent ${options.agentId}.`);
    }
    return renderHistory("Visible Chat", visibleMessages(state, agent, messages));
  }
  return renderHistory("All Chat", messages);
}

export async function sendPendingChatReminders(
  state: RunState,
  now: Date = new Date(),
  sender: NoticeSender = sendTmuxPaneText
): Promise<number> {
  const messages = await readChatMessages(state);
  const reads = await readJson<ReadState>(readsPath(state), {});
  const delivery = await readJson<DeliveryState>(deliveryPath(state), {});
  let sent = 0;

  for (const agent of state.agents) {
    const visible = visibleMessages(state, agent, messages);
    const unread = unreadMessages(visible, reads, agent).filter((message) => {
      const delivered = delivery[message.id]?.[agent.id];
      if (!delivered?.immediateSentAt || delivered.reminderSentAt) {
        return false;
      }
      return now.getTime() - new Date(delivered.immediateSentAt).getTime() >= REMINDER_DELAY_MS;
    });

    for (const group of groupUnread(unread)) {
      sender(agent.paneId, pendingNotice(group), agent.preset);
      sent += 1;
      for (const message of group) {
        delivery[message.id] = delivery[message.id] ?? {};
        delivery[message.id][agent.id] = {
          ...delivery[message.id][agent.id],
          reminderSentAt: now.toISOString()
        };
      }
    }
  }

  if (sent > 0) {
    await writeJson(deliveryPath(state), delivery);
  }
  await renderChatArtifacts(state);
  return sent;
}
