import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../../version.js";
import { theme } from "../theme.js";
import type { KeyHint } from "../keys/keymap.js";
import { KeyBar } from "./KeyBar.js";
import { useTerminalSize } from "./useTerminalSize.js";

export type AppShellStatus = {
  text: string;
  tone: "info" | "warn" | "error";
};

export type AppShellProps = {
  title: string;
  step?: { index: number; total: number };
  hints: KeyHint[];
  status?: AppShellStatus;
  onDisabledHint?: (reason: string) => void;
  children: React.ReactNode;
};

function statusColor(tone: AppShellStatus["tone"]): string {
  if (tone === "error") {
    return theme.error;
  }
  if (tone === "warn") {
    return theme.warning;
  }
  return theme.dim;
}

export function AppShell({ title, step, hints, status, onDisabledHint, children }: AppShellProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Box flexShrink={0} justifyContent="space-between" paddingX={1}>
        <Text>
          <Text bold color={theme.title}>
            Agent Arena
          </Text>
          <Text color={theme.dim}> v{VERSION}</Text>
          <Text color={theme.dim}> · </Text>
          <Text color={theme.active}>{title}</Text>
        </Text>
        {step ? (
          <Text color={theme.dim}>
            Step {step.index}/{step.total}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0} paddingX={1} height={1}>
        {status ? <Text color={statusColor(status.tone)}>{status.text}</Text> : <Text> </Text>}
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
        {children}
      </Box>
      <Box flexShrink={0} paddingX={1}>
        <KeyBar hints={hints} onDisabledHint={onDisabledHint} />
      </Box>
    </Box>
  );
}
