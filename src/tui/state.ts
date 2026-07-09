import { draftFromConfig, emptyDraft, type TuiDraft } from "../tui-model.js";
import type { ArenaConfig } from "../types.js";
import type { Route } from "./routes.js";

export type WizardInit = {
  repoRoot?: string;
  existingConfig?: ArenaConfig;
  configError?: string;
  draft?: TuiDraft;
  stack?: Route[];
  notices?: string[];
  projectCandidates?: string[];
  // True once a setup-helper session has been launched for this draft, so
  // Review can distinguish "run helper" from "send feedback to a prior run".
  helperRan?: boolean;
};

export type WizardBusy = {
  label: string;
};

export type WizardState = {
  stack: Route[];
  draft: TuiDraft;
  repoRoot?: string;
  existingConfig?: ArenaConfig;
  configError?: string;
  notices: string[];
  projectCandidates: string[];
  dirty: boolean;
  busy?: WizardBusy;
  // Teams-table row selection, kept in wizard state so it survives the
  // Teams screen unmounting while a sub-screen (agent editor) is open.
  teamsSelection?: string;
  helperRan: boolean;
};

export type WizardAction =
  | { type: "push"; route: Route }
  | { type: "pop" }
  | { type: "replaceStack"; stack: Route[] }
  | { type: "setDraft"; draft: TuiDraft }
  | { type: "projectLoaded"; repoRoot: string; config?: ArenaConfig; error?: string; draft?: TuiDraft }
  | { type: "setNotices"; notices: string[] }
  | { type: "setBusy"; busy?: WizardBusy }
  | { type: "setTeamsSelection"; value?: string };

export function initialWizardState(init: WizardInit): WizardState {
  return {
    stack: init.stack ?? [{ name: "project" }],
    draft: init.draft ?? draftFromConfig(init.existingConfig),
    repoRoot: init.repoRoot,
    existingConfig: init.existingConfig,
    configError: init.configError,
    notices: init.notices ?? [],
    projectCandidates: init.projectCandidates ?? [],
    dirty: Boolean(init.draft),
    busy: undefined,
    helperRan: init.helperRan ?? false
  };
}

export function currentRoute(state: WizardState): Route {
  return state.stack[state.stack.length - 1] ?? { name: "project" };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "push":
      return { ...state, stack: [...state.stack, action.route] };
    case "pop":
      return state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : state;
    case "replaceStack":
      return action.stack.length > 0 ? { ...state, stack: action.stack } : state;
    case "setDraft":
      return { ...state, draft: action.draft, dirty: true };
    case "projectLoaded":
      return {
        ...state,
        repoRoot: action.repoRoot,
        existingConfig: action.config,
        configError: action.error,
        draft: action.draft ?? draftFromConfig(action.config),
        dirty: false
      };
    case "setNotices":
      return { ...state, notices: action.notices };
    case "setBusy":
      return { ...state, busy: action.busy };
    case "setTeamsSelection":
      return { ...state, teamsSelection: action.value };
    default:
      return state;
  }
}

export function freshDraft(): TuiDraft {
  return emptyDraft();
}
