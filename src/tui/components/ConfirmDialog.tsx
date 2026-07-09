import React, { useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { Clickable } from "../mouse/Clickable.js";

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type ConfirmDialogProps = ConfirmOptions & {
  onResult: (confirmed: boolean) => void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onResult
}: ConfirmDialogProps): React.ReactElement {
  const [selected, setSelected] = useState<"confirm" | "cancel">(danger ? "cancel" : "confirm");

  useKeys(
    (input, key) => {
      if (key.escape) {
        onResult(false);
        return true;
      }
      if (key.return) {
        onResult(selected === "confirm");
        return true;
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        setSelected((current) => (current === "confirm" ? "cancel" : "confirm"));
        return true;
      }
      if (input === "y" || input === "Y") {
        onResult(true);
        return true;
      }
      if (input === "n" || input === "N") {
        onResult(false);
        return true;
      }
      return true; // Dialog swallows all other keys.
    },
    { priority: KEY_PRIORITY.field }
  );

  const confirmColors = danger
    ? { backgroundColor: theme.dangerBg, color: theme.dangerFg }
    : { backgroundColor: theme.selectionBg, color: theme.selectionFg };

  return (
    <Box flexDirection="column">
      <Text bold color={danger ? theme.error : theme.title}>
        {title}
      </Text>
      <Text wrap="wrap">{message}</Text>
      <Box marginTop={1} gap={3} justifyContent="center">
        <Clickable onPress={() => onResult(true)}>
          <Text {...(selected === "confirm" ? confirmColors : { color: theme.dim })}>
            {` ${confirmLabel} `}
          </Text>
        </Clickable>
        <Clickable onPress={() => onResult(false)}>
          <Text
            {...(selected === "cancel"
              ? { backgroundColor: theme.selectionBg, color: theme.selectionFg }
              : { color: theme.dim })}
          >
            {` ${cancelLabel} `}
          </Text>
        </Clickable>
      </Box>
      <Text color={theme.dim}>Enter confirm · Esc cancel · ←/→ switch</Text>
    </Box>
  );
}
