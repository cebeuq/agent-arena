import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { KeyHint } from "../keys/keymap.js";
import { Clickable } from "../mouse/Clickable.js";

export type KeyBarProps = {
  hints: KeyHint[];
  onDisabledHint?: (reason: string) => void;
};

export function KeyBar({ hints, onDisabledHint }: KeyBarProps): React.ReactElement {
  return (
    <Box flexShrink={0}>
      {hints.map((entry, index) => {
        const body = (
          <Text key={`${entry.key}-${index}`}>
            <Text
              color={entry.disabled ? theme.disabled : theme.selectionFg}
              backgroundColor={entry.disabled ? undefined : theme.selectionBg}
              dimColor={entry.disabled}
            >
              {` ${entry.key} `}
            </Text>
            <Text color={entry.disabled ? theme.disabled : theme.dim} dimColor={entry.disabled}>
              {` ${entry.label}  `}
            </Text>
          </Text>
        );

        const onPress = entry.disabled
          ? () => {
              if (entry.disabledReason) {
                onDisabledHint?.(entry.disabledReason);
              }
            }
          : entry.onPress;

        if (!onPress) {
          return (
            <Box key={`${entry.key}-${index}`} flexShrink={0}>
              {body}
            </Box>
          );
        }

        return (
          <Clickable key={`${entry.key}-${index}`} flexShrink={0} onPress={onPress}>
            {body}
          </Clickable>
        );
      })}
    </Box>
  );
}
