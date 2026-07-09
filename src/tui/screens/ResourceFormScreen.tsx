import React, { useState } from "react";
import { Text } from "ink";
import type { ArenaResource, ArenaResourceType } from "../../types.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { FieldRow } from "../components/FieldRow.js";
import { useModal } from "../components/ModalProvider.js";
import { openTextPrompt } from "../components/prompts.js";
import { useWizard } from "../app.js";
import { stepForRoute, type ResourceScope } from "../routes.js";
import {
  blankResource,
  resourceFieldSpecs,
  scopedResources,
  scopeTitle,
  validateResource,
  withScopedResources,
  type ResourceFieldKey
} from "../view-models/resources-vm.js";

export function ResourceFormScreen({
  scope,
  index,
  newType
}: {
  scope: ResourceScope;
  index?: number;
  newType?: ArenaResourceType;
}): React.ReactElement {
  const { state, dispatch, toast, showToast } = useWizard();
  const modal = useModal();
  const draft = state.draft;
  const resources = scopedResources(draft, scope);
  const original = index !== undefined ? resources[index] : undefined;
  const [resource, setResource] = useState<ArenaResource>(original ?? blankResource(newType ?? "note"));
  const [modified, setModified] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [fieldIndex, setFieldIndex] = useState(0);

  const specs = resourceFieldSpecs(resource.type);
  const errors = validateResource(resource);
  // "Name is required." on a form the user has not touched reads as a
  // reprimand; only surface validation once they edited or tried to save.
  const showErrors = modified || attemptedSave;
  const rowCount = specs.length + 2; // + optional toggle + save row
  const optionalRow = specs.length;
  const saveRow = specs.length + 1;
  const valid = Object.keys(errors).length === 0;

  function setField(key: ResourceFieldKey, value: string): void {
    setResource((current) => ({ ...current, [key]: value.trim() || undefined }));
    setModified(true);
  }

  function save(): void {
    if (!valid) {
      setAttemptedSave(true);
      showToast("Fix the highlighted fields before saving.", "warn");
      return;
    }
    const next =
      index !== undefined
        ? resources.map((candidate, i) => (i === index ? resource : candidate))
        : [...resources, resource];
    dispatch({ type: "setDraft", draft: withScopedResources(draft, scope, next) });
    dispatch({ type: "pop" });
  }

  function cancel(): void {
    if (!modified) {
      dispatch({ type: "pop" });
      return;
    }
    void modal
      .confirm({
        title: "Discard changes?",
        message: "This resource has unsaved edits.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true
      })
      .then((confirmed) => {
        if (confirmed) {
          dispatch({ type: "pop" });
        }
      });
  }

  function activate(): void {
    if (fieldIndex === optionalRow) {
      setResource((current) => ({ ...current, optional: !current.optional }));
      setModified(true);
      return;
    }
    if (fieldIndex === saveRow) {
      save();
      return;
    }
    const spec = specs[fieldIndex];
    const currentValue = (resource[spec.key] as string | undefined) ?? "";
    void openTextPrompt(modal, {
      title: spec.label,
      label: spec.hint,
      initial: currentValue,
      placeholder: spec.placeholder,
      width: 70
    }).then((value) => {
      if (value !== undefined) {
        setField(spec.key, value);
      }
    });
  }

  useKeys((_input, key) => {
    if (key.upArrow) {
      setFieldIndex((current) => Math.max(0, current - 1));
      return true;
    }
    if (key.downArrow) {
      setFieldIndex((current) => Math.min(rowCount - 1, current + 1));
      return true;
    }
    if (key.home) {
      setFieldIndex(0);
      return true;
    }
    if (key.end) {
      setFieldIndex(rowCount - 1);
      return true;
    }
    if (key.return) {
      activate();
      return true;
    }
    if (key.escape) {
      cancel();
      return true;
    }
    return false;
  });

  return (
    <AppShell
      title={`Setup — ${index !== undefined ? "Edit" : "New"} ${resource.type} resource`}
      step={stepForRoute({ name: "resourceForm", scope })}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Edit", { onPress: activate }),
        hint("Esc", "Cancel", { onPress: cancel })
      ]}
    >
      <Panel title={`${scopeTitle(draft, scope)} — ${resource.type}`} flexGrow={1}>
        {specs.map((spec, i) => (
          <FieldRow
            key={spec.key}
            label={spec.label}
            required={spec.required}
            selected={i === fieldIndex}
            error={showErrors ? errors[spec.key] : undefined}
          >
            <Text color={(resource[spec.key] as string | undefined) ? undefined : theme.dim}>
              {/* Placeholders render as explicit examples so they can't be
                  mistaken for saved values. */}
              {(resource[spec.key] as string | undefined) ?? (spec.placeholder ? `e.g. ${spec.placeholder}` : "not set")}
            </Text>
          </FieldRow>
        ))}
        <FieldRow label="Optional" selected={fieldIndex === optionalRow}>
          <Text>{resource.optional ? "yes — missing is a warning" : "no — missing blocks arena start"}</Text>
        </FieldRow>
        <FieldRow label="" selected={fieldIndex === saveRow}>
          <Text color={valid ? theme.success : theme.disabled}>
            [ Save resource ]{valid || !showErrors ? "" : " — fix highlighted fields first"}
          </Text>
        </FieldRow>
      </Panel>
    </AppShell>
  );
}
