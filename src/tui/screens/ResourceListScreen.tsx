import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Text } from "ink";
import {
  describeAvailability,
  readSecretsEnv,
  resolveResourceAvailability,
  type ResourceAvailabilityContext
} from "../../resources.js";
import type { ArenaResourceType } from "../../types.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openSelectPrompt } from "../components/prompts.js";
import { useWizard } from "../app.js";
import type { ResourceScope } from "../routes.js";
import { RESOURCE_TYPES, scopedResources, scopeTitle, withScopedResources } from "../view-models/resources-vm.js";

export function ResourceListScreen({ scope }: { scope: ResourceScope }): React.ReactElement {
  const { state, dispatch, toast, showToast } = useWizard();
  const modal = useModal();
  const draft = state.draft;
  const resources = scopedResources(draft, scope);
  const [selected, setSelected] = useState<string | undefined>(resources.length > 0 ? "0" : undefined);

  const context = useMemo<ResourceAvailabilityContext>(() => {
    if (!state.repoRoot) {
      return {};
    }
    return {
      savedSecrets: readSecretsEnv(path.join(state.repoRoot, ".agent-arena")),
      baseDir: state.repoRoot
    };
  }, [state.repoRoot]);

  const items = useMemo<Array<SelectListItem<string>>>(
    () =>
      resources.map((resource, index) => {
        const availability = resolveResourceAvailability(resource, context);
        return {
          value: String(index),
          label: `${resource.type.padEnd(8)} ${resource.name || "(unnamed)"}`,
          detail: describeAvailability(availability),
          accentColor: availability.status === "missing" ? theme.warning : undefined
        };
      }),
    [resources, context]
  );

  useEffect(() => {
    if (selected !== undefined && Number.parseInt(selected, 10) >= resources.length) {
      setSelected(resources.length > 0 ? String(resources.length - 1) : undefined);
    }
  }, [resources.length, selected]);

  function addResource(): void {
    void openSelectPrompt(modal, {
      title: "Resource type",
      items: RESOURCE_TYPES.map((type) => ({ value: type, label: type }))
    }).then((type) => {
      if (type) {
        dispatch({ type: "push", route: { name: "resourceForm", scope, newType: type as ArenaResourceType } });
      }
    });
  }

  function editSelected(value: string): void {
    dispatch({ type: "push", route: { name: "resourceForm", scope, index: Number.parseInt(value, 10) } });
  }

  function deleteSelected(): void {
    if (selected === undefined) {
      showToast("Nothing selected.", "warn");
      return;
    }
    const index = Number.parseInt(selected, 10);
    const resource = resources[index];
    if (!resource) {
      return;
    }
    void modal
      .confirm({
        title: "Remove resource",
        message: `Remove ${resource.type} resource "${resource.name || "(unnamed)"}"?`,
        confirmLabel: "Remove",
        danger: true
      })
      .then((confirmed) => {
        if (confirmed) {
          dispatch({
            type: "setDraft",
            draft: withScopedResources(draft, scope, resources.filter((_candidate, i) => i !== index))
          });
        }
      });
  }

  useKeys((input) => {
    if (input === "a") {
      addResource();
      return true;
    }
    if (input === "d") {
      deleteSelected();
      return true;
    }
    return false;
  });

  return (
    <AppShell
      title={`Setup — ${scopeTitle(draft, scope)}`}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Edit", { onPress: () => selected !== undefined && editSelected(selected) }),
        hint("a", "Add", { onPress: addResource }),
        hint("d", "Delete", { onPress: deleteSelected }),
        hint("Esc", "Back", { onPress: () => dispatch({ type: "pop" }) })
      ]}
    >
      <Panel title={scopeTitle(draft, scope)} flexGrow={1}>
        {items.length > 0 ? (
          <SelectList
            items={items}
            selected={selected}
            onSelect={setSelected}
            onActivate={editSelected}
            height={Math.max(4, items.length)}
          />
        ) : (
          <Text color={theme.dim}>No resources yet. Press a to add one.</Text>
        )}
        <Text> </Text>
        <Text color={theme.dim}>
          Resources are declared capabilities (env keys, files, hosts). Agents are ordered to check them before
          working.
        </Text>
      </Panel>
    </AppShell>
  );
}
