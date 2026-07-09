import React, { useRef } from "react";
import { Box, type BoxProps, type DOMElement } from "ink";
import { useMouseRegion } from "./useMouseRegion.js";

export type ClickableProps = BoxProps & {
  onPress: () => void;
  disabled?: boolean;
  children: React.ReactNode;
};

export function Clickable({ onPress, disabled, children, ...boxProps }: ClickableProps): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  useMouseRegion(ref, {
    onPress: () => onPress(),
    disabled
  });

  return (
    <Box ref={ref} {...boxProps}>
      {children}
    </Box>
  );
}
