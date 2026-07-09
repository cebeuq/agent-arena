import React from "react";
import { Box, Text, type BoxProps } from "ink";
import { theme } from "../theme.js";

export type PanelProps = BoxProps & {
  title?: string;
  tone?: "default" | "accent" | "warning";
  children: React.ReactNode;
};

function toneColor(tone: PanelProps["tone"]): string {
  if (tone === "accent") {
    return theme.active;
  }
  if (tone === "warning") {
    return theme.warning;
  }
  return theme.border;
}

export function Panel({ title, tone = "default", children, ...boxProps }: PanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={toneColor(tone)} paddingX={1} {...boxProps}>
      {title ? (
        <Text bold color={theme.title}>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  );
}
