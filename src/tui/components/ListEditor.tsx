import React, { useState } from "react";
import { Box, Text } from "ink";
import { glyphs, theme } from "../theme.js";
import { useKeys } from "../keys/useKeys.js";
import { Clickable } from "../mouse/Clickable.js";
import { TextField } from "./TextField.js";

export type ListEditorProps = {
  items: string[];
  onChange: (items: string[]) => void;
  label: string;
  placeholder?: string;
  width?: number;
  onDone?: () => void;
};

type Editing = {
  index: number; // items.length means "adding a new item"
  value: string;
};

export function ListEditor({
  items,
  onChange,
  label,
  placeholder = "Type and press Enter",
  width = 50,
  onDone
}: ListEditorProps): React.ReactElement {
  const [selected, setSelected] = useState(items.length === 0 ? 0 : 0);
  const [editing, setEditing] = useState<Editing | undefined>();

  const addRowIndex = items.length;
  const clampedSelected = Math.max(0, Math.min(selected, addRowIndex));

  function commitEdit(value: string): void {
    if (!editing) {
      return;
    }
    const trimmed = value.trim();
    if (editing.index === addRowIndex) {
      if (trimmed) {
        onChange([...items, trimmed]);
        setSelected(items.length + 1);
      }
    } else if (trimmed) {
      onChange(items.map((item, index) => (index === editing.index ? trimmed : item)));
    } else {
      onChange(items.filter((_item, index) => index !== editing.index));
      setSelected(Math.max(0, editing.index - 1));
    }
    setEditing(undefined);
  }

  function startEdit(index: number): void {
    setSelected(index);
    setEditing({ index, value: index === addRowIndex ? "" : items[index] ?? "" });
  }

  function deleteSelected(): void {
    if (clampedSelected >= items.length) {
      return;
    }
    onChange(items.filter((_item, index) => index !== clampedSelected));
    setSelected(Math.max(0, clampedSelected - 1));
  }

  useKeys(
    (input, key) => {
      if (editing) {
        return false; // TextField owns input while editing.
      }
      if (key.upArrow) {
        setSelected(Math.max(0, clampedSelected - 1));
        return true;
      }
      if (key.downArrow) {
        setSelected(Math.min(addRowIndex, clampedSelected + 1));
        return true;
      }
      if (key.return) {
        startEdit(clampedSelected);
        return true;
      }
      if (input === "a") {
        startEdit(addRowIndex);
        return true;
      }
      if (input === "d") {
        deleteSelected();
        return true;
      }
      if (key.escape) {
        if (onDone) {
          onDone();
          return true;
        }
        return false;
      }
      return false;
    }
  );

  return (
    <Box flexDirection="column">
      <Text bold color={theme.title}>
        {label}
      </Text>
      {items.map((item, index) => {
        if (editing && editing.index === index) {
          return (
            <Box key={`edit-${index}`}>
              <Text color={theme.active}>{`${glyphs.pointer} `}</Text>
              <TextField
                value={editing.value}
                onChange={(value) => setEditing({ index, value })}
                onSubmit={commitEdit}
                onCancel={() => setEditing(undefined)}
                width={width}
                placeholder={placeholder}
              />
            </Box>
          );
        }
        const isSelected = !editing && index === clampedSelected;
        return (
          <Clickable key={`item-${index}`} onPress={() => startEdit(index)}>
            <Text
              backgroundColor={isSelected ? theme.selectionBg : undefined}
              color={isSelected ? theme.selectionFg : undefined}
              wrap="truncate"
            >
              {`${isSelected ? glyphs.pointer : " "} ${item}`.padEnd(width)}
            </Text>
          </Clickable>
        );
      })}
      {editing && editing.index === addRowIndex ? (
        <Box>
          <Text color={theme.active}>{`${glyphs.pointer} `}</Text>
          <TextField
            value={editing.value}
            onChange={(value) => setEditing({ index: addRowIndex, value })}
            onSubmit={commitEdit}
            onCancel={() => setEditing(undefined)}
            width={width}
            placeholder={placeholder}
          />
        </Box>
      ) : (
        <Clickable onPress={() => startEdit(addRowIndex)}>
          <Text
            backgroundColor={!editing && clampedSelected === addRowIndex ? theme.selectionBg : undefined}
            color={!editing && clampedSelected === addRowIndex ? theme.selectionFg : theme.dim}
          >
            {`${!editing && clampedSelected === addRowIndex ? glyphs.pointer : " "} [ + Add item ]`.padEnd(width)}
          </Text>
        </Clickable>
      )}
      <Text color={theme.dim}>Enter edit · a add · d delete · Esc done</Text>
    </Box>
  );
}
