import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { theme } from "../theme.js";

export function Spinner({ label }: { label: string }): React.ReactElement {
  return (
    <Box>
      <Text color={theme.active}>
        <InkSpinner type="dots" />
      </Text>
      <Text> {label}</Text>
    </Box>
  );
}
