import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { ClaimRecord } from "../../types.js";
import { formatLocalTime, pluralize } from "../../format.js";
import { theme } from "../theme.js";
import { useKeys } from "../keys/useKeys.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openTextPrompt } from "../components/prompts.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { agentDisplayName, askedForMoreAt, pendingClaims } from "./model.js";
import { useOverseer } from "./overseer-app.js";

export function JudgeView(): React.ReactElement {
  const { snapshot, actions, readOnly, runAction, judgeAgentId, showToast, offerHarvest } = useOverseer();
  const modal = useModal();
  const { rows } = useTerminalSize();
  const pending = useMemo(() => pendingClaims(snapshot), [snapshot]);
  const [selected, setSelected] = useState<string | undefined>(judgeAgentId ?? pending[0]?.agentId);

  useEffect(() => {
    if (judgeAgentId && pending.some((claim) => claim.agentId === judgeAgentId)) {
      setSelected(judgeAgentId);
    }
  }, [judgeAgentId, pending]);

  useEffect(() => {
    if (!selected || !pending.some((claim) => claim.agentId === selected)) {
      setSelected(pending[0]?.agentId);
    }
  }, [pending, selected]);

  const claim = pending.find((candidate) => candidate.agentId === selected);
  const agent = claim ? snapshot.state.agents.find((candidate) => candidate.id === claim.agentId) : undefined;
  const progress = claim ? snapshot.progress.find((candidate) => candidate.agentId === claim.agentId) : undefined;
  const askedAt = claim ? askedForMoreAt(snapshot, claim) : undefined;

  const verdictHistory = snapshot.state.claims.filter((candidate) => candidate.status !== "pending");

  function acceptSelected(target: ClaimRecord): void {
    const rivals = snapshot.state.agents.filter((candidate) => candidate.id !== target.agentId).length;
    void modal
      .confirm({
        title: "Accept claim and END the run?",
        message: `${agentDisplayName(snapshot, target.agentId)} wins, the other ${pluralize(rivals, "agent pane")} ${rivals === 1 ? "is" : "are"} interrupted with Ctrl-C, and the final report is written. This cannot be undone.`,
        confirmLabel: "Accept & finish",
        cancelLabel: "Cancel",
        danger: true
      })
      .then((confirmed) => {
        if (confirmed) {
          void runAction("Finishing run (interrupting rival panes)…", () => actions.acceptClaim(target.agentId)).then(
            (accepted) => {
              if (accepted) {
                showToast(`Accepted ${agentDisplayName(snapshot, target.agentId)}'s claim. Run finished.`, "info");
                offerHarvest(target.agentId);
              }
            }
          );
        } else {
          showToast("Cancelled — claim still pending.", "info");
        }
      });
  }

  function rejectSelected(target: ClaimRecord): void {
    void openTextPrompt(modal, {
      title: `Reject ${agentDisplayName(snapshot, target.agentId)}'s claim`,
      label: "Optional reason shown to the agent in its pane.",
      placeholder: "e.g. tests still failing on the edge cases",
      width: 70
    }).then((note) => {
      if (note === undefined) {
        return;
      }
      void runAction("Rejecting claim…", () => actions.rejectClaim(target.agentId, note || undefined)).then(
        (rejected) => {
          if (rejected) {
            showToast(`Rejected ${agentDisplayName(snapshot, target.agentId)}'s claim; the agent was notified.`, "info");
          }
        }
      );
    });
  }

  function askSelected(target: ClaimRecord): void {
    void openTextPrompt(modal, {
      title: `Ask ${agentDisplayName(snapshot, target.agentId)} for more`,
      label: "Sends a Director DM; the claim stays pending.",
      placeholder: "e.g. how did you verify the benchmark numbers?",
      width: 70
    }).then((question) => {
      if (!question?.trim()) {
        return;
      }
      void runAction("Sending question…", () => actions.askForMore(target.agentId, question.trim())).then((sent) => {
        if (sent) {
          showToast(`Question sent to ${agentDisplayName(snapshot, target.agentId)}.`, "info");
        }
      });
    });
  }

  useKeys((input) => {
    if (!claim || readOnly) {
      return false;
    }
    if (input === "a") {
      acceptSelected(claim);
      return true;
    }
    if (input === "x") {
      rejectSelected(claim);
      return true;
    }
    if (input === "m") {
      askSelected(claim);
      return true;
    }
    return false;
  });

  const items: Array<SelectListItem<string>> = pending.map((candidate) => {
    const candidateAgent = snapshot.state.agents.find((a) => a.id === candidate.agentId);
    return {
      value: candidate.agentId,
      label: `${candidateAgent?.codename ?? candidate.agentId} (${candidate.agentId}) — ${candidateAgent?.teamName ?? candidate.teamId ?? ""}`,
      detail: `claimed ${formatLocalTime(candidate.claimedAt, { seconds: true })}`
    };
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title={`Pending claims (${pending.length})`}>
        {items.length > 0 ? (
          <SelectList
            items={items}
            selected={selected}
            onSelect={setSelected}
            onActivate={() => {}}
            height={Math.min(4, Math.max(1, items.length))}
          />
        ) : (
          <Text color={theme.dim}>
            No pending claims. Captains submit one with ./.arena/claim.sh when they believe they are done.
          </Text>
        )}
      </Panel>
      {claim && agent ? (
        <Panel title={`Claim by ${agent.codename} (${agent.id})`} flexGrow={1}>
          <Text color={theme.dim}>
            {agent.teamName} captain · claimed at {formatLocalTime(claim.claimedAt, { date: true, seconds: true })}
            {askedAt ? ` · asked for more at ${formatLocalTime(askedAt, { seconds: true })}` : ""}
          </Text>
          <Text wrap="truncate">Goal: {snapshot.state.goal}</Text>
          <Text>
            Changed files: {progress?.changedFiles.length ?? 0}
            {progress?.changedFiles.length ? ` — ${progress.changedFiles.slice(0, 6).join(", ")}` : ""}
          </Text>
          {progress?.diffStat ? (
            <Box flexDirection="column">
              {progress.diffStat
                .split("\n")
                .slice(-Math.max(3, rows - 22))
                .map((line, index) => (
                  <Text key={index} color={theme.dim} wrap="truncate">
                    {line}
                  </Text>
                ))}
            </Box>
          ) : (
            <Text color={theme.dim}>(no tracked diff yet)</Text>
          )}
          {claim.note ? <Text color={theme.dim}>note: {claim.note}</Text> : null}
          {claim.stdout.trim() ? <Text wrap="truncate">stdout: {claim.stdout.trim().slice(0, 200)}</Text> : null}
          <Text> </Text>
          <Text color={readOnly ? theme.dim : undefined}>
            <Text color={theme.success}>a</Text> ACCEPT & end run · <Text color={theme.error}>x</Text> reject with note
            · <Text color={theme.active}>m</Text> ask for more (claim stays pending)
          </Text>
        </Panel>
      ) : (
        <Panel title="Claim history" flexGrow={1}>
          {verdictHistory.length > 0 ? (
            verdictHistory.slice(-10).map((candidate, index) => (
              <Text key={`${candidate.agentId}-${index}`} color={theme.dim} wrap="truncate">
                {candidate.agentId}: {candidate.status} at {formatLocalTime(candidate.verifiedAt ?? candidate.claimedAt, { date: true })}
                {candidate.note ? ` — ${candidate.note}` : ""}
              </Text>
            ))
          ) : (
            <Text color={theme.dim}>No judged claims yet.</Text>
          )}
        </Panel>
      )}
    </Box>
  );
}
