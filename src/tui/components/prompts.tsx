import React, { useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { TextField } from "./TextField.js";
import { SelectList, type SelectListItem } from "./SelectList.js";
import type { ModalApi } from "./ModalProvider.js";

export type TextPromptOptions = {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  width?: number;
  validate?: (value: string) => string | undefined;
};

function TextPrompt({
  options,
  onDone
}: {
  options: TextPromptOptions;
  onDone: (value: string | undefined) => void;
}): React.ReactElement {
  const [value, setValue] = useState(options.initial ?? "");
  const width = (options.width ?? 56) - 4;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.title}>
        {options.title}
      </Text>
      {options.label ? <Text color={theme.dim}>{options.label}</Text> : null}
      <TextField
        value={value}
        onChange={setValue}
        onSubmit={(submitted) => {
          if (options.validate?.(submitted)) {
            return; // Inline error already visible; keep editing.
          }
          onDone(submitted);
        }}
        onCancel={() => onDone(undefined)}
        width={width}
        placeholder={options.placeholder}
        validate={options.validate}
      />
      <Text color={theme.dim}>Enter save · Esc cancel</Text>
    </Box>
  );
}

// Opens a modal text input; resolves with the submitted value or undefined on cancel.
export function openTextPrompt(modal: ModalApi, options: TextPromptOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    modal.openModal(
      (close) => (
        <TextPrompt
          options={options}
          onDone={(value) => {
            close();
            resolve(value);
          }}
        />
      ),
      { width: options.width ?? 56 }
    );
  });
}

export type SelectPromptOptions<T extends string> = {
  title: string;
  items: Array<SelectListItem<T>>;
  selected?: T;
  height?: number;
};

function SelectPrompt<T extends string>({
  options,
  onDone
}: {
  options: SelectPromptOptions<T>;
  onDone: (value: T | undefined) => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<T | undefined>(
    options.selected ?? options.items.find((item) => !item.header && !item.disabled)?.value
  );

  useKeys(
    (_input, key) => {
      if (key.escape) {
        onDone(undefined);
        return true;
      }
      return false;
    },
    { priority: KEY_PRIORITY.screen }
  );

  return (
    <Box flexDirection="column">
      <Text bold color={theme.title}>
        {options.title}
      </Text>
      <SelectList
        items={options.items}
        selected={selected}
        onSelect={setSelected}
        onActivate={(value) => onDone(value)}
        height={options.height ?? Math.min(10, options.items.length)}
      />
      <Text color={theme.dim}>Enter select · Esc cancel</Text>
    </Box>
  );
}

// Opens a modal pick list; resolves with the chosen value or undefined on cancel.
export function openSelectPrompt<T extends string>(
  modal: ModalApi,
  options: SelectPromptOptions<T>
): Promise<T | undefined> {
  return new Promise((resolve) => {
    modal.openModal((close) => (
      <SelectPrompt
        options={options}
        onDone={(value) => {
          close();
          resolve(value);
        }}
      />
    ));
  });
}
