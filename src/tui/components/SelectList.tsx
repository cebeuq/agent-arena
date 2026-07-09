import React, { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";
import { glyphs, theme } from "../theme.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { useMouseRegion } from "../mouse/useMouseRegion.js";
import { useTerminalSize } from "./useTerminalSize.js";

export type SelectListItem<T extends string> = {
  value: T;
  label: string;
  detail?: string;
  accentColor?: string;
  header?: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export type SelectListProps<T extends string> = {
  items: Array<SelectListItem<T>>;
  selected: T | undefined;
  onSelect: (value: T) => void;
  onActivate: (value: T) => void;
  height: number;
  focused?: boolean;
  onDisabledActivate?: (reason: string) => void;
};

type Window = {
  start: number;
  capacity: number;
  showAbove: boolean;
  showBelow: boolean;
};

export function computeWindow(totalRows: number, height: number, offset: number): Window {
  if (totalRows <= height) {
    return { start: 0, capacity: totalRows, showAbove: false, showBelow: false };
  }

  const start = Math.max(0, Math.min(offset, totalRows - 1));
  const showAbove = start > 0;
  let capacity = height - (showAbove ? 1 : 0);
  let showBelow = start + capacity < totalRows;
  if (showBelow) {
    capacity = height - (showAbove ? 1 : 0) - 1;
    showBelow = start + capacity < totalRows;
    if (!showBelow) {
      capacity = height - (showAbove ? 1 : 0);
    }
  }

  return { start, capacity: Math.max(1, capacity), showAbove, showBelow };
}

function rowText(item: SelectListItem<string>, width: number, selected: boolean): string {
  const marker = selected ? glyphs.pointer : " ";
  const detail = item.detail ?? "";
  const base = `${marker} ${item.label}`;
  const available = Math.max(0, width - detail.length - (detail ? 1 : 0));
  const clipped = base.length > available ? `${base.slice(0, Math.max(0, available - 1))}…` : base.padEnd(available);
  return detail ? `${clipped} ${detail}` : clipped;
}

export function SelectList<T extends string>({
  items,
  selected,
  onSelect,
  onActivate,
  height,
  focused = true,
  onDisabledActivate
}: SelectListProps<T>): React.ReactElement {
  const containerRef = useRef<DOMElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [width, setWidth] = useState(40);
  const { columns, rows } = useTerminalSize();

  const selectableIndexes = items.flatMap((item, index) => (item.header ? [] : [index]));
  const selectedIndex = items.findIndex((item) => !item.header && item.value === selected);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const measured = measureElement(node);
    if (measured.width > 0 && measured.width !== width) {
      setWidth(measured.width);
    }
  }, [columns, rows, items.length, width]);

  // Keep the selection inside the visible window.
  useEffect(() => {
    if (selectedIndex === -1) {
      return;
    }
    setOffset((current) => {
      const window = computeWindow(items.length, height, current);
      if (selectedIndex < window.start) {
        return selectedIndex;
      }
      if (selectedIndex >= window.start + window.capacity) {
        return selectedIndex - window.capacity + 1;
      }
      return current;
    });
  }, [selectedIndex, items.length, height]);

  const window = computeWindow(items.length, height, offset);

  function moveSelection(delta: number): void {
    if (selectableIndexes.length === 0) {
      return;
    }
    const position = selectableIndexes.indexOf(selectedIndex);
    const next = position === -1
      ? delta > 0 ? 0 : selectableIndexes.length - 1
      : Math.max(0, Math.min(selectableIndexes.length - 1, position + delta));
    const item = items[selectableIndexes[next]];
    if (item) {
      onSelect(item.value);
    }
  }

  function activate(item: SelectListItem<T>): void {
    if (item.disabled) {
      if (item.disabledReason) {
        onDisabledActivate?.(item.disabledReason);
      }
      return;
    }
    onActivate(item.value);
  }

  function scrollBy(delta: number): void {
    setOffset((current) => Math.max(0, Math.min(items.length - 1, current + delta)));
  }

  useKeys(
    (_input, key) => {
      if (key.upArrow) {
        moveSelection(-1);
        return true;
      }
      if (key.downArrow) {
        moveSelection(1);
        return true;
      }
      if (key.pageUp) {
        moveSelection(-window.capacity);
        return true;
      }
      if (key.pageDown) {
        moveSelection(window.capacity);
        return true;
      }
      if (key.home) {
        moveSelection(-selectableIndexes.length);
        return true;
      }
      if (key.end) {
        moveSelection(selectableIndexes.length);
        return true;
      }
      if (key.return) {
        const item = items[selectedIndex];
        if (item) {
          activate(item);
        }
        return true;
      }
      return false;
    },
    { enabled: focused, priority: KEY_PRIORITY.list }
  );

  useMouseRegion(containerRef, {
    onPress: ({ localY }) => {
      let row = localY;
      if (window.showAbove) {
        if (row === 0) {
          scrollBy(-1);
          return;
        }
        row -= 1;
      }
      if (window.showBelow && row === window.capacity) {
        scrollBy(1);
        return;
      }
      const item = items[window.start + row];
      if (!item || item.header) {
        return;
      }
      onSelect(item.value);
      activate(item);
    },
    onWheel: ({ direction }) => {
      scrollBy(direction === "up" ? -1 : 1);
    }
  });

  const visible = items.slice(window.start, window.start + window.capacity);

  return (
    <Box ref={containerRef} flexDirection="column" flexGrow={1}>
      {window.showAbove ? (
        <Text color={theme.dim}>{`${glyphs.moreAbove} ${window.start} more`}</Text>
      ) : null}
      {visible.map((item, visibleIndex) => {
        const absoluteIndex = window.start + visibleIndex;
        if (item.header) {
          return (
            <Text key={`header-${item.value}`} bold color={item.accentColor ?? theme.title} wrap="truncate">
              {item.label.length > width ? item.label.slice(0, width) : item.label.padEnd(width)}
            </Text>
          );
        }
        const isSelected = absoluteIndex === selectedIndex;
        const text = rowText(item, width, isSelected);
        if (isSelected) {
          return (
            <Text key={item.value} backgroundColor={theme.selectionBg} color={theme.selectionFg} wrap="truncate">
              {text}
            </Text>
          );
        }
        return (
          <Text
            key={item.value}
            color={item.disabled ? theme.disabled : item.accentColor}
            dimColor={item.disabled}
            wrap="truncate"
          >
            {text}
          </Text>
        );
      })}
      {window.showBelow ? (
        <Text color={theme.dim}>{`${glyphs.moreBelow} ${items.length - window.start - window.capacity} more`}</Text>
      ) : null}
    </Box>
  );
}
