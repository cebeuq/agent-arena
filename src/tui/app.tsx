import React, { createContext, useContext, useMemo, useReducer } from "react";
import { Box, useApp } from "ink";
import type { AgentPresetId, ArenaConfig } from "../types.js";
import type { TuiDraft } from "../tui-model.js";
import { KeyProvider } from "./keys/KeyProvider.js";
import { useKeys, KEY_PRIORITY } from "./keys/useKeys.js";
import { MouseProvider } from "./mouse/MouseProvider.js";
import { ModalProvider, useModal } from "./components/ModalProvider.js";
import { Panel } from "./components/Panel.js";
import { Spinner } from "./components/Spinner.js";
import { useToast } from "./components/useToast.js";
import type { AppShellStatus } from "./components/AppShell.js";
import { LayerContext } from "./layers.js";
import { currentRoute, initialWizardState, wizardReducer, type WizardAction, type WizardInit, type WizardState } from "./state.js";
import { ProjectScreen } from "./screens/ProjectScreen.js";
import { TeamsScreen } from "./screens/TeamsScreen.js";
import { AgentEditorScreen } from "./screens/AgentEditorScreen.js";
import { TaskScreen } from "./screens/TaskScreen.js";
import { ReviewScreen } from "./screens/ReviewScreen.js";
import { ResourceListScreen } from "./screens/ResourceListScreen.js";
import { ResourceFormScreen } from "./screens/ResourceFormScreen.js";

export type ExitRequest =
  | { kind: "quit" }
  | { kind: "start"; repoRoot: string; config: ArenaConfig }
  | { kind: "helper"; repoRoot: string; draft: TuiDraft; helper: AgentPresetId; feedback?: string };

export type WizardContextValue = {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  toast: AppShellStatus | undefined;
  showToast: (text: string, tone?: AppShellStatus["tone"]) => void;
  requestExit: (request: ExitRequest) => void;
};

const WizardContext = createContext<WizardContextValue | undefined>(undefined);

export function useWizard(): WizardContextValue {
  const value = useContext(WizardContext);
  if (!value) {
    throw new Error("useWizard must be used inside WizardApp.");
  }
  return value;
}

function BusyOverlay({ label }: { label: string }): React.ReactElement {
  useKeys(() => true, { priority: KEY_PRIORITY.field });
  return (
    <Box position="absolute" marginTop={10} width="100%" justifyContent="center">
      <Panel tone="accent">
        <Spinner label={label} />
      </Panel>
    </Box>
  );
}

function WizardRoot({ init, onExit }: { init: WizardInit; onExit: (request: ExitRequest) => void }): React.ReactElement {
  const [state, dispatch] = useReducer(wizardReducer, init, initialWizardState);
  const { toast, showToast } = useToast();
  const modal = useModal();
  const { exit } = useApp();

  const requestExit = useMemo(
    () => (request: ExitRequest) => {
      onExit(request);
      exit();
    },
    [onExit, exit]
  );

  function confirmQuit(): void {
    if (!state.dirty) {
      requestExit({ kind: "quit" });
      return;
    }
    void modal
      .confirm({
        title: "Quit setup?",
        message: "Your draft has unsaved changes that will be lost.",
        confirmLabel: "Quit",
        cancelLabel: "Keep editing",
        danger: true
      })
      .then((confirmed) => {
        if (confirmed) {
          requestExit({ kind: "quit" });
        }
      });
  }

  useKeys(
    (input, key) => {
      if (key.escape) {
        if (state.stack.length > 1) {
          dispatch({ type: "pop" });
        } else {
          confirmQuit();
        }
        return true;
      }
      if (key.ctrl && input === "c") {
        confirmQuit();
        return true;
      }
      if (input === "q" && !key.ctrl && !key.meta) {
        confirmQuit();
        return true;
      }
      return false;
    },
    { priority: KEY_PRIORITY.global }
  );

  const value = useMemo<WizardContextValue>(
    () => ({ state, dispatch, toast, showToast, requestExit }),
    [state, toast, showToast, requestExit]
  );

  const route = currentRoute(state);

  return (
    <WizardContext.Provider value={value}>
      {route.name === "project" ? <ProjectScreen /> : null}
      {route.name === "teams" ? <TeamsScreen /> : null}
      {route.name === "agentEditor" ? <AgentEditorScreen agentId={route.agentId} /> : null}
      {route.name === "task" ? <TaskScreen /> : null}
      {route.name === "review" ? <ReviewScreen /> : null}
      {route.name === "resources" ? <ResourceListScreen scope={route.scope} /> : null}
      {route.name === "resourceForm" ? (
        <ResourceFormScreen scope={route.scope} index={route.index} newType={route.newType} />
      ) : null}
      {state.busy ? (
        <LayerContext.Provider value={1000}>
          <BusyOverlay label={state.busy.label} />
        </LayerContext.Provider>
      ) : null}
    </WizardContext.Provider>
  );
}

export function WizardApp({ init, onExit }: { init: WizardInit; onExit: (request: ExitRequest) => void }): React.ReactElement {
  return (
    <KeyProvider>
      <MouseProvider>
        <ModalProvider>
          <WizardRoot init={init} onExit={onExit} />
        </ModalProvider>
      </MouseProvider>
    </KeyProvider>
  );
}
