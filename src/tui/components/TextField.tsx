import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useCursor, type DOMElement } from "ink";
import { theme } from "../theme.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { useMouseRegion } from "../mouse/useMouseRegion.js";
import { absoluteRect } from "../mouse/geometry.js";
import { useTerminalSize } from "./useTerminalSize.js";

export type TextFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  focused?: boolean;
  width: number;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  secret?: boolean;
};

// Renders nothing; pins the real terminal cursor at the given screen cell. Mounted
// only for the focused field so multiple fields never fight over the cursor.
function HardwareCursor({ x, y }: { x: number; y: number }): null {
  const { setCursorPosition } = useCursor();
  setCursorPosition({ x, y });
  return null;
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function wordLeft(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !isWordChar(value[index - 1])) {
    index -= 1;
  }
  while (index > 0 && isWordChar(value[index - 1])) {
    index -= 1;
  }
  return index;
}

function wordRight(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && !isWordChar(value[index])) {
    index += 1;
  }
  while (index < value.length && isWordChar(value[index])) {
    index += 1;
  }
  return index;
}

function printable(input: string): string {
  // Strip control characters; tabs become spaces.
  return [...input].filter((char) => char === "\t" || char.charCodeAt(0) >= 32).join("").replaceAll("\t", " ");
}

// Bracketed-paste markers arrive as plain text once Ink strips the leading ESC;
// without this they would be typed into the field as literal "[200~" / "[201~".
function stripPasteMarkers(input: string): string {
  return input.replaceAll(/\x1b?\[20[01]~/g, "");
}

export function TextField({
  value,
  onChange,
  onSubmit,
  onCancel,
  focused = true,
  width,
  placeholder,
  validate,
  secret = false
}: TextFieldProps): React.ReactElement {
  const fieldRef = useRef<DOMElement | null>(null);
  const [cursor, setCursor] = useState(value.length);
  const [scroll, setScroll] = useState(0);
  const [cursorCell, setCursorCell] = useState<{ x: number; y: number } | undefined>();
  const { columns, rows } = useTerminalSize();

  const clampedCursor = Math.max(0, Math.min(cursor, value.length));

  // Keep the cursor inside the visible window.
  useEffect(() => {
    setScroll((current) => {
      if (clampedCursor < current) {
        return clampedCursor;
      }
      if (clampedCursor > current + width - 1) {
        return clampedCursor - width + 1;
      }
      return Math.max(0, Math.min(current, Math.max(0, value.length - width + 1)));
    });
  }, [clampedCursor, width, value.length]);

  // Pin the hardware cursor to the field's live yoga rect after each commit.
  useEffect(() => {
    if (!focused) {
      setCursorCell(undefined);
      return;
    }
    const rect = absoluteRect(fieldRef.current);
    if (!rect) {
      return;
    }
    const next = { x: rect.x + (clampedCursor - scroll), y: rect.y };
    setCursorCell((current) => (current?.x === next.x && current?.y === next.y ? current : next));
  });

  function edit(nextValue: string, nextCursor: number): void {
    onChange(nextValue);
    setCursor(Math.max(0, Math.min(nextCursor, nextValue.length)));
  }

  useKeys(
    (input, key) => {
      if (key.escape) {
        if (onCancel) {
          onCancel();
          return true;
        }
        return false;
      }
      if (key.return) {
        onSubmit?.(value);
        return true;
      }
      if (key.leftArrow) {
        setCursor(key.ctrl || key.meta ? wordLeft(value, clampedCursor) : Math.max(0, clampedCursor - 1));
        return true;
      }
      if (key.rightArrow) {
        setCursor(key.ctrl || key.meta ? wordRight(value, clampedCursor) : Math.min(value.length, clampedCursor + 1));
        return true;
      }
      if (key.home || (key.ctrl && input === "a")) {
        setCursor(0);
        return true;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setCursor(value.length);
        return true;
      }
      if (key.backspace || key.delete) {
        if (clampedCursor > 0) {
          edit(value.slice(0, clampedCursor - 1) + value.slice(clampedCursor), clampedCursor - 1);
        }
        return true;
      }
      if (key.ctrl && input === "d") {
        if (clampedCursor < value.length) {
          edit(value.slice(0, clampedCursor) + value.slice(clampedCursor + 1), clampedCursor);
        }
        return true;
      }
      if (key.ctrl && input === "u") {
        edit(value.slice(clampedCursor), 0);
        return true;
      }
      if (key.ctrl && input === "k") {
        edit(value.slice(0, clampedCursor), clampedCursor);
        return true;
      }
      if (key.ctrl && input === "w") {
        const start = wordLeft(value, clampedCursor);
        edit(value.slice(0, start) + value.slice(clampedCursor), start);
        return true;
      }
      if (key.meta && (input === "b" || input === "f")) {
        setCursor(input === "b" ? wordLeft(value, clampedCursor) : wordRight(value, clampedCursor));
        return true;
      }
      if (key.tab) {
        // Swallow Tab while typing: elsewhere it changes views/screens, which
        // would silently discard the draft under the cursor.
        return true;
      }
      if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        return false;
      }

      // Multi-character input is a paste. Insert it wholesale with newlines
      // collapsed to spaces; submitting on the first newline (a bare Enter is
      // key.return, handled above) would silently truncate the pasted text.
      const cleaned = stripPasteMarkers(input);
      const insert =
        cleaned.length > 1 ? printable(cleaned.replaceAll(/\r\n|[\r\n]/g, " ")) : printable(cleaned);
      if (insert) {
        edit(value.slice(0, clampedCursor) + insert + value.slice(clampedCursor), clampedCursor + insert.length);
        return true;
      }
      return false;
    },
    { priority: KEY_PRIORITY.field, enabled: focused }
  );

  useMouseRegion(fieldRef, {
    onPress: ({ localX }) => {
      setCursor(Math.max(0, Math.min(value.length, scroll + localX)));
    },
    disabled: !focused
  });

  const display = secret ? "•".repeat(value.length) : value;
  const visible = display.slice(scroll, scroll + width).padEnd(width);
  const error = validate?.(value);
  const showPlaceholder = value.length === 0 && Boolean(placeholder);

  return (
    <Box flexDirection="column">
      <Box ref={fieldRef} width={width}>
        {showPlaceholder ? (
          <Text color={theme.dim} wrap="truncate">
            {placeholder!.slice(0, width).padEnd(width)}
          </Text>
        ) : (
          <Text color={focused ? undefined : theme.dim} wrap="truncate">
            {visible}
          </Text>
        )}
      </Box>
      {error ? (
        <Text color={theme.error} wrap="truncate">
          {error}
        </Text>
      ) : null}
      {focused && cursorCell && columns > 0 && rows > 0 ? <HardwareCursor x={cursorCell.x} y={cursorCell.y} /> : null}
    </Box>
  );
}
