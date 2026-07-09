import fs from "node:fs/promises";
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ProposalRecord } from "../../proposals.js";
import { pluralize } from "../../format.js";
import { theme } from "../theme.js";
import { useKeys } from "../keys/useKeys.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { summarizePatch, type PatchSummary } from "./model.js";
import { useOverseer } from "./overseer-app.js";

function statusColor(status: ProposalRecord["status"]): string | undefined {
  if (status === "applied") {
    return theme.success;
  }
  if (status === "failed") {
    return theme.error;
  }
  return theme.warning;
}

export function ProposalsView(): React.ReactElement {
  const { snapshot, actions, readOnly, runAction, showToast } = useOverseer();
  const modal = useModal();
  const { rows } = useTerminalSize();
  const proposals = snapshot.proposals;
  const [selected, setSelected] = useState<string | undefined>(proposals[0]?.id);
  const [detailId, setDetailId] = useState<string | undefined>();
  const [patchSummary, setPatchSummary] = useState<PatchSummary | undefined>();
  const [patchError, setPatchError] = useState<string | undefined>();

  const detail = detailId ? proposals.find((candidate) => candidate.id === detailId) : undefined;

  useEffect(() => {
    if (!selected || !proposals.some((candidate) => candidate.id === selected)) {
      setSelected(proposals[0]?.id);
    }
  }, [proposals, selected]);

  useEffect(() => {
    setPatchSummary(undefined);
    setPatchError(undefined);
    if (!detail) {
      return;
    }
    let cancelled = false;
    void fs
      .readFile(detail.patchPath, "utf8")
      .then((patch) => {
        if (!cancelled) {
          setPatchSummary(summarizePatch(patch));
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setPatchError(`Could not read patch: ${error.message}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.id, detail?.patchPath]);

  function applySelected(record: ProposalRecord): void {
    if (record.status !== "pending") {
      showToast(`Proposal is already ${record.status}.`, "warn");
      return;
    }
    void modal
      .confirm({
        title: "Apply proposal",
        message: `Apply "${record.title}" to ${record.captainAgentId}'s workspace? This modifies the captain worktree with git apply --3way.`,
        confirmLabel: "Apply",
        // Modifies the captain's worktree; default to the safe side.
        defaultButton: "cancel"
      })
      .then((confirmed) => {
        if (confirmed) {
          void runAction("Applying proposal…", () => actions.applyProposal(record.id)).then((applied) => {
            if (applied) {
              showToast(
                applied.status === "applied"
                  ? `Applied ${applied.id}.`
                  : `Apply failed: ${applied.statusNote ?? "unknown error"}`,
                applied.status === "applied" ? "info" : "error"
              );
            }
          });
        }
      });
  }

  useKeys((input, key) => {
    if (detail) {
      if (key.escape) {
        setDetailId(undefined);
        return true;
      }
      if (input === "a" && !readOnly) {
        applySelected(detail);
        return true;
      }
      return false;
    }
    if (input === "a" && !readOnly && selected) {
      const record = proposals.find((candidate) => candidate.id === selected);
      if (record) {
        applySelected(record);
      }
      return true;
    }
    return false;
  });

  if (detail) {
    return (
      <Panel title={`Proposal ${detail.id} — ${detail.status}`} flexGrow={1}>
        <Text bold>{detail.title}</Text>
        <Text color={theme.dim}>
          from {detail.fromCodename} ({detail.fromAgentId}) → captain {detail.captainAgentId} · {detail.createdAt}
        </Text>
        <Text wrap="wrap">{detail.summary || "(no summary)"}</Text>
        <Text> </Text>
        {patchError ? <Text color={theme.error}>{patchError}</Text> : null}
        {patchSummary ? (
          <Box flexDirection="column">
            <Text>
              Patch: {pluralize(patchSummary.files.length, "file")}, +{patchSummary.additions} −{patchSummary.deletions}
              <Text color={theme.dim}>  {detail.patchPath}</Text>
            </Text>
            {patchSummary.files.slice(0, Math.max(3, rows - 18)).map((file) => (
              <Text key={file.path} color={theme.dim} wrap="truncate">
                {"  "}
                {file.path} +{file.additions} −{file.deletions}
              </Text>
            ))}
          </Box>
        ) : patchError ? null : (
          <Text color={theme.dim}>Reading patch…</Text>
        )}
        {detail.statusNote ? <Text color={statusColor(detail.status)}>note: {detail.statusNote}</Text> : null}
        <Text> </Text>
        <Text color={theme.dim}>
          {detail.status === "pending" && !readOnly ? "a apply to captain workspace · " : ""}Esc back to list
        </Text>
      </Panel>
    );
  }

  const items: Array<SelectListItem<string>> = proposals.map((record) => ({
    value: record.id,
    label: `${record.title}  — from ${record.fromCodename} (${record.fromAgentId})`,
    detail: record.status,
    accentColor: statusColor(record.status)
  }));

  return (
    <Panel title="Patch proposals" flexGrow={1}>
      {items.length > 0 ? (
        <SelectList
          items={items}
          selected={selected}
          onSelect={setSelected}
          onActivate={(value) => setDetailId(value)}
          height={Math.max(4, rows - 14)}
        />
      ) : (
        <Text color={theme.dim}>
          No proposals yet. Non-captain teammates create them with ./.arena/propose-patch.sh in their workspaces.
        </Text>
      )}
      <Text color={theme.dim}>Enter view details · a apply selected</Text>
    </Panel>
  );
}
