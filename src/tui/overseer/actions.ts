import path from "node:path";
import { markMessagesRead, sendChatMessage, USER_SENDER_ID, type ChatMessage, type ChatScope } from "../../chat.js";
import { acceptManualClaim, rejectManualClaim } from "../../claim.js";
import { harvestRun, type HarvestResult } from "../../harvest.js";
import { sendManualPressureNotice, updateCompetitionArtifacts } from "../../competition.js";
import { spawnMirrorDaemon } from "../../daemon.js";
import { refreshAllMirrors } from "../../mirror.js";
import { applyProposal, readProposalRecords, type ProposalRecord } from "../../proposals.js";
import { readRunState, withRunLock, writeRunState } from "../../run-state.js";
import type { ClaimRecord } from "../../types.js";
import type { RunWatcher } from "./run-watcher.js";

export type OverseerActions = {
  sendUserChat(options: { scope: ChatScope; message: string; teamId?: string; toAgentId?: string }): Promise<ChatMessage>;
  markThreadRead(messageIds: string[]): Promise<void>;
  acceptClaim(agentId: string): Promise<ClaimRecord>;
  harvestWinner(): Promise<HarvestResult>;
  rejectClaim(agentId: string, note?: string): Promise<ClaimRecord>;
  askForMore(agentId: string, question: string): Promise<ChatMessage>;
  applyProposal(proposalId: string): Promise<ProposalRecord>;
  sendPressure(options?: { agentId?: string; message?: string }): Promise<number>;
  restartDaemon(): Promise<number | undefined>;
};

export type CreateActionsOptions = {
  runId: string;
  statePath: string;
  cliPath: string;
  watcher?: RunWatcher;
};

export function createActions(options: CreateActionsOptions): OverseerActions {
  const { runId, statePath, cliPath, watcher } = options;

  async function refreshed<T>(result: T): Promise<T> {
    await watcher?.refreshNow();
    return result;
  }

  return {
    async sendUserChat(send) {
      const message = await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        const sent = await sendChatMessage(state, {
          fromAgentId: USER_SENDER_ID,
          scope: send.scope,
          message: send.message,
          teamId: send.teamId,
          toAgentId: send.toAgentId
        });
        await writeRunState(state);
        return sent;
      });
      return refreshed(message);
    },

    async markThreadRead(messageIds) {
      if (messageIds.length === 0) {
        return;
      }
      await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        await markMessagesRead(state, USER_SENDER_ID, messageIds);
      });
      await watcher?.refreshNow();
    },

    async acceptClaim(agentId) {
      const claim = await acceptManualClaim({ runId, agentId, statePath });
      return refreshed(claim);
    },

    async harvestWinner() {
      const result = await harvestRun({ runId, statePath });
      return refreshed(result);
    },

    async rejectClaim(agentId, note) {
      const claim = await rejectManualClaim({ runId, agentId, statePath, note });
      return refreshed(claim);
    },

    async askForMore(agentId, question) {
      const message = await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        const sent = await sendChatMessage(state, {
          fromAgentId: USER_SENDER_ID,
          scope: "dm",
          toAgentId: agentId,
          message: `JUDGE QUESTION about your finish claim: ${question}`
        });
        await writeRunState(state);
        return sent;
      });
      return refreshed(message);
    },

    async applyProposal(proposalId) {
      const record = await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        const records = await readProposalRecords(state);
        const target = records.find((candidate) => candidate.id === proposalId);
        if (!target) {
          throw new Error(`Unknown proposal ${proposalId}.`);
        }
        const applied = await applyProposal(state, {
          agentId: target.captainAgentId,
          proposalId
        });
        await writeRunState(state);
        return applied;
      });
      return refreshed(record);
    },

    async sendPressure(pressure = {}) {
      const count = await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        await refreshAllMirrors(state);
        await updateCompetitionArtifacts(state);
        const sent = sendManualPressureNotice(state, {
          agentId: pressure.agentId,
          message: pressure.message
        });
        await writeRunState(state);
        return sent;
      });
      return refreshed(count);
    },

    async restartDaemon() {
      const pid = await withRunLock(statePath, async () => {
        const state = await readRunState(statePath);
        const spawned = spawnMirrorDaemon(
          runId,
          statePath,
          cliPath,
          path.join(state.runDir, "mirror-daemon.log")
        );
        state.mirrorDaemonPid = spawned;
        await writeRunState(state);
        return spawned;
      });
      return refreshed(pid);
    }
  };
}
