import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { glyphs, theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openTextPrompt } from "../components/prompts.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { useWizard } from "../app.js";
import { stepForRoute } from "../routes.js";
import { createProject, selectProject } from "./project-actions.js";
import { isEmptyDir, listDirectory, type DirectoryListing } from "../view-models/browse-vm.js";

const USE_HERE = "__use__";
const NEW_FOLDER = "__mkdir__";
const UP = "__up__";

export function BrowseScreen({ startDir }: { startDir?: string }): React.ReactElement {
  const { state, dispatch, toast, showToast } = useWizard();
  const modal = useModal();
  const { rows } = useTerminalSize();
  const [dir, setDir] = useState<string>(() => path.resolve(startDir ?? state.repoRoot ?? process.cwd() ?? os.homedir()));
  const [listing, setListing] = useState<DirectoryListing | undefined>();
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void listDirectory(dir).then((result) => {
      if (!cancelled) {
        setListing(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const currentIsRepo = existsSync(path.join(dir, ".git"));

  const items = useMemo<Array<SelectListItem<string>>>(() => {
    const list: Array<SelectListItem<string>> = [
      {
        value: USE_HERE,
        label: currentIsRepo ? "✓ Use this folder (git repo)" : "✓ Use this folder",
        detail: currentIsRepo ? "load" : "new project"
      },
      { value: NEW_FOLDER, label: "+ New folder here", detail: "create" }
    ];
    if (listing?.parent) {
      list.push({ value: UP, label: ".. (up one level)" });
    }
    for (const entry of listing?.entries ?? []) {
      list.push({
        value: `dir:${entry.fullPath}`,
        label: `${entry.name}/`,
        detail: entry.isGitRepo ? "● git repo" : undefined,
        accentColor: entry.isGitRepo ? theme.success : entry.hidden ? theme.dim : undefined
      });
    }
    return list;
  }, [listing, currentIsRepo]);

  useEffect(() => {
    if (!selected || !items.some((item) => item.value === selected)) {
      setSelected(items[0]?.value);
    }
  }, [items, selected]);

  function goUp(): void {
    if (listing?.parent) {
      setDir(listing.parent);
      setSelected(undefined);
    }
  }

  // Returns to the Project screen after a folder is chosen so the user sees
  // the loaded project and proceeds ("Use this project" / "Edit existing").
  function finishSelection(): void {
    dispatch({ type: "pop" });
  }

  async function useHere(): Promise<void> {
    const here = dir;
    // A git repo loads directly (this is exactly the folder to run in).
    if (existsSync(path.join(here, ".git"))) {
      if (await selectProject({ dispatch, showToast }, here)) {
        finishSelection();
      }
      return;
    }
    // Otherwise offer to make a fresh Arena project here, but only if empty —
    // createNewProject refuses a non-empty non-repo folder.
    if (await isEmptyDir(here)) {
      const ok = await modal.confirm({
        title: "Create a new project here?",
        message: `${here}\n\nThis empty folder will become a git repo with a README and .gitignore.`,
        confirmLabel: "Create here",
        cancelLabel: "Cancel",
        defaultButton: "cancel"
      });
      if (ok && (await createProject({ dispatch, showToast }, here))) {
        finishSelection();
      }
      return;
    }
    showToast(
      "This folder isn't a git repo and isn't empty. Open a subfolder, or use New folder here to start a fresh project.",
      "warn"
    );
  }

  function newFolder(): void {
    void openTextPrompt(modal, {
      title: "New folder",
      label: `Create a folder inside ${dir}`,
      placeholder: "my-project",
      validate: (value) => {
        const name = value.trim();
        if (!name) {
          return undefined;
        }
        if (name.includes("/") || name === "." || name === "..") {
          return "Enter a single folder name (no slashes).";
        }
        return undefined;
      }
    }).then((name) => {
      const trimmed = name?.trim();
      if (!trimmed) {
        return;
      }
      const target = path.join(dir, trimmed);
      void fs
        .mkdir(target, { recursive: false })
        .then(() => {
          setDir(target); // Navigate into the new (empty) folder.
          setSelected(USE_HERE);
          showToast(`Created ${trimmed}. Use this folder to make it your project.`, "info");
        })
        .catch((error: Error) => {
          showToast(`Could not create folder: ${error.message}`, "error");
        });
    });
  }

  function activate(value: string): void {
    if (value === USE_HERE) {
      void useHere();
    } else if (value === NEW_FOLDER) {
      newFolder();
    } else if (value === UP) {
      goUp();
    } else if (value.startsWith("dir:")) {
      setDir(value.slice("dir:".length));
      setSelected(undefined);
    }
  }

  useKeys((input, key) => {
    if (input === "u") {
      void useHere();
      return true;
    }
    if (input === "n") {
      newFolder();
      return true;
    }
    if (key.leftArrow || key.backspace) {
      goUp();
      return true;
    }
    if (key.escape) {
      dispatch({ type: "pop" });
      return true;
    }
    return false;
  });

  const listHeight = Math.max(6, rows - 11);

  return (
    <AppShell
      title="Setup — Browse for a folder"
      step={stepForRoute({ name: "browse" })}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Open / Use", { onPress: () => selected && activate(selected) }),
        hint("u", "Use this folder", { onPress: () => void useHere() }),
        hint("n", "New folder", { onPress: newFolder }),
        hint("←", "Up", { onPress: goUp }),
        hint("Esc", "Back", { onPress: () => dispatch({ type: "pop" }) })
      ]}
    >
      <Box flexGrow={1} flexDirection="column">
        <Box flexShrink={0} paddingX={1}>
          <Text>
            <Text color={theme.dim}>Folder: </Text>
            <Text color={theme.active} wrap="truncate-start">
              {dir}
            </Text>
          </Text>
        </Box>
        <Panel title="Contents" flexGrow={1}>
          {listing?.error ? (
            <Text color={theme.error} wrap="truncate">
              {listing.error}
            </Text>
          ) : (
            <SelectList
              items={items}
              selected={selected}
              onSelect={setSelected}
              onActivate={activate}
              height={listHeight}
            />
          )}
          <Text color={theme.dim} wrap="truncate">
            Enter a folder to open it · ● marks git repos · &quot;Use this folder&quot; loads a repo or starts a new
            project here.
          </Text>
        </Panel>
      </Box>
    </AppShell>
  );
}
