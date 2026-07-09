import type { TuiDraft } from "../../tui-model.js";
import { updateAgentDraft, updateTeamDraft } from "./teams-vm.js";
import type { ArenaResource, ArenaResourceType } from "../../types.js";
import type { ResourceScope } from "../routes.js";

export const RESOURCE_TYPES: ArenaResourceType[] = ["env", "ssh", "gpu", "url", "file", "cloud", "dataset", "note"];

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ResourceFieldKey =
  | "name"
  | "envVar"
  | "host"
  | "user"
  | "path"
  | "url"
  | "provider"
  | "notes"
  | "usage"
  | "whenToUse"
  | "description"
  | "budget"
  | "cleanup"
  | "verification";

export type ResourceFieldSpec = {
  key: ResourceFieldKey;
  label: string;
  required: boolean;
  placeholder?: string;
  hint?: string;
};

const COMMON_HEAD: ResourceFieldSpec[] = [{ key: "name", label: "Name", required: true, placeholder: "Display name" }];

const COMMON_TAIL: ResourceFieldSpec[] = [
  {
    key: "usage",
    label: "Usage",
    required: false,
    placeholder: "What should agents do with it?",
    hint: "Without usage/when-to-use, agents may treat the resource as passive context."
  },
  { key: "whenToUse", label: "When to use", required: false, placeholder: "Trigger conditions" },
  { key: "description", label: "Description", required: false },
  { key: "budget", label: "Budget/limits", required: false },
  { key: "cleanup", label: "Cleanup", required: false },
  { key: "verification", label: "Verification", required: false }
];

const TYPE_FIELDS: Record<ArenaResourceType, ResourceFieldSpec[]> = {
  env: [{ key: "envVar", label: "Env var", required: true, placeholder: "MY_API_KEY" }],
  ssh: [
    { key: "host", label: "Host", required: true, placeholder: "host.example.com" },
    { key: "user", label: "User", required: false }
  ],
  gpu: [{ key: "host", label: "Host", required: false }],
  url: [{ key: "url", label: "URL", required: true, placeholder: "https://…" }],
  file: [{ key: "path", label: "Path", required: true, placeholder: "path/to/file" }],
  cloud: [{ key: "provider", label: "Provider", required: false }],
  dataset: [
    { key: "path", label: "Path", required: false, hint: "Dataset needs a path or a URL." },
    { key: "url", label: "URL", required: false }
  ],
  note: [{ key: "notes", label: "Note text", required: false }]
};

export function resourceFieldSpecs(type: ArenaResourceType): ResourceFieldSpec[] {
  return [...COMMON_HEAD, ...TYPE_FIELDS[type], ...COMMON_TAIL];
}

export function blankResource(type: ArenaResourceType): ArenaResource {
  return { type, name: "" };
}

export function validateResource(resource: ArenaResource): Partial<Record<ResourceFieldKey, string>> {
  const errors: Partial<Record<ResourceFieldKey, string>> = {};
  if (!resource.name?.trim()) {
    errors.name = "Name is required.";
  }
  if (resource.type === "env") {
    if (!resource.envVar?.trim()) {
      errors.envVar = "Env var name is required.";
    } else if (!ENV_VAR_PATTERN.test(resource.envVar)) {
      errors.envVar = "Use an environment variable name, not a raw secret value.";
    }
  }
  if (resource.type === "ssh" && !resource.host?.trim()) {
    errors.host = "Host is required for ssh resources.";
  }
  if (resource.type === "url" && !resource.url?.trim()) {
    errors.url = "URL is required for url resources.";
  }
  if (resource.type === "file" && !resource.path?.trim()) {
    errors.path = "Path is required for file resources.";
  }
  if (resource.type === "dataset" && !resource.path?.trim() && !resource.url?.trim()) {
    errors.path = "Dataset resources need a path or a URL.";
  }
  return errors;
}

export function scopeTitle(draft: TuiDraft, scope: ResourceScope): string {
  if (scope.kind === "shared") {
    return "Shared resources";
  }
  if (scope.kind === "team") {
    const team = draft.teams.find((candidate) => candidate.id === scope.teamId);
    return `${team?.name ?? scope.teamId} team resources`;
  }
  return `${scope.agentId} resources`;
}

export function scopedResources(draft: TuiDraft, scope: ResourceScope): ArenaResource[] {
  if (scope.kind === "shared") {
    return draft.resources;
  }
  if (scope.kind === "team") {
    return draft.teams.find((candidate) => candidate.id === scope.teamId)?.resources ?? [];
  }
  return draft.agents.find((candidate) => candidate.id === scope.agentId)?.resources ?? [];
}

export function withScopedResources(draft: TuiDraft, scope: ResourceScope, resources: ArenaResource[]): TuiDraft {
  if (scope.kind === "shared") {
    return { ...draft, resources };
  }
  if (scope.kind === "team") {
    return updateTeamDraft(draft, scope.teamId, (team) => ({ ...team, resources }));
  }
  return updateAgentDraft(draft, scope.agentId, (agent) => ({ ...agent, resources }));
}
