import React from "react";
import { Box, Text } from "ink";
import { glyphs, theme } from "../theme.js";

export type FieldRowProps = {
  label: string;
  required?: boolean;
  selected: boolean;
  disabled?: boolean;
  error?: string;
  labelWidth?: number;
  children: React.ReactNode;
};

export function FieldRow({
  label,
  required = false,
  selected,
  disabled = false,
  error,
  labelWidth = 18,
  children
}: FieldRowProps): React.ReactElement {
  const marker = selected ? glyphs.pointer : " ";
  const name = `${label}${required ? " *" : ""}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          color={selected ? theme.selectionFg : disabled ? theme.disabled : undefined}
          backgroundColor={selected ? theme.selectionBg : undefined}
          dimColor={disabled && !selected}
        >
          {`${marker} ${name.padEnd(labelWidth)} `}
        </Text>
        {children}
      </Box>
      {error ? (
        <Text color={theme.error}>{`  ${" ".repeat(labelWidth)} ${error}`}</Text>
      ) : null}
    </Box>
  );
}
