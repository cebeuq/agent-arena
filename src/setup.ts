import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { agentPresets } from "./presets.js";
import { parseEnvFile, serializeEnvFile } from "./resources.js";
import { commandExists, runChecked, shellQuote } from "./shell.js";
import { attachTmuxSession } from "./terminal.js";
import { builtInAgentIds, draftFromSelectedPresets, emptyDraft, type TuiDraft } from "./tui-model.js";
import type { AgentPresetId, ArenaResource, ArenaResourceType, JudgingConfig } from "./types.js";

const envVarSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const setupResourceSchema = z.object({
  type: z.enum(["env", "ssh", "gpu", "url", "file", "cloud", "dataset", "note"]),
  name: z.string().min(1),
  optional: z.boolean().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  usage: z.string().optional(),
  whenToUse: z.string().optional(),
  budget: z.string().optional(),
  cleanup: z.string().optional(),
  verification: z.string().optional(),
  envVar: envVarSchema.optional(),
  host: z.string().optional(),
  user: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  provider: z.string().optional(),
  notes: z.string().optional()
});

const setupSecretSchema = z.object({
  name: z.string().optional(),
  envVar: envVarSchema,
  value: z.string().optional()
});

export const setupDraftSchema = z.object({
  goal: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).default([]),
  verifyCommand: z.string().min(1).optional(),
  judging: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("manual")
      }),
      z.object({
        mode: z.literal("verifier"),
        verifyCommand: z.string().min(1)
      })
    ])
    .optional(),
  resources: z.array(setupResourceSchema).default([]),
  teamInstructions: z.record(z.string(), z.string()).default({}),
  teamResources: z.record(z.string(), z.array(setupResourceSchema)).default({}),
  agentInstructions: z.record(z.string(), z.string()).default({}),
  agentResources: z.record(z.string(), z.array(setupResourceSchema)).default({}),
  secrets: z.array(setupSecretSchema).default([])
});

export type SetupDraft = z.infer<typeof setupDraftSchema>;
type SetupResourceDraft = z.infer<typeof setupResourceSchema>;
type SetupSecretDraft = z.infer<typeof setupSecretSchema>;

const setupResourceTypes = ["env", "ssh", "gpu", "url", "file", "cloud", "dataset", "note"] as const satisfies ArenaResourceType[];

const looseSetupDraftSchema = z
  .object({
    goal: z.unknown().optional(),
    successCriteria: z.unknown().optional(),
    constraints: z.unknown().optional(),
    verifyCommand: z.unknown().optional(),
    judging: z.unknown().optional(),
    resources: z.unknown().optional(),
    teamInstructions: z.unknown().optional(),
    teamResources: z.unknown().optional(),
    agentInstructions: z.unknown().optional(),
    agentResources: z.unknown().optional(),
    secrets: z.unknown().optional()
  })
  .passthrough();

export type SetupHelperResult = {
  ok: boolean;
  draft?: TuiDraft;
  warnings: string[];
  blockedChanges?: string;
};

export type SetupDraftPreviewView = "contract" | "json";

export type NewProjectResult = {
  repoRoot: string;
  warnings: string[];
};

function setupDraftPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "setup-draft.json");
}

function setupSecretsPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "setup-secrets.env");
}

function setupCompletionPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "setup-complete.sh");
}

function setupAutoExitPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "setup-auto-exit.sh");
}

function setupVerifierPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "setup", "verifier.sh");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupDraftIsValid(repoRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(setupDraftPath(repoRoot), "utf8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    stdio: "ignore"
  });
  return result.status === 0;
}

function tmuxPaneExists(sessionName: string, paneId: string): boolean {
  const result = spawnSync("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_id}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.split("\n").some((line) => line.trim() === paneId);
}

async function waitForSetupHelper(repoRoot: string, sessionName: string, helperPane?: string): Promise<void> {
  const deadline = Date.now() + 1000 * 60 * 60;
  while (Date.now() < deadline) {
    if (await setupDraftIsValid(repoRoot)) {
      return;
    }
    if (!tmuxSessionExists(sessionName)) {
      return;
    }
    // The draft-watch pane keeps the session alive even after the helper CLI
    // exits; without this check a helper that quit without writing a draft
    // would leave us (and the user) waiting on "Waiting for helper output...".
    if (helperPane && !tmuxPaneExists(sessionName, helperPane)) {
      return;
    }
    await sleep(1000);
  }
}

function secretsPath(repoRoot: string): string {
  return path.join(repoRoot, ".agent-arena", "secrets.env");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, label: string, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Ignored ${label}: expected a list.`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (typeof item !== "string") {
      warnings.push(`Ignored ${label} item ${index + 1}: expected text.`);
      return [];
    }
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function stringRecord(value: unknown, label: string, warnings: string[]): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    warnings.push(`Ignored ${label}: expected an object.`);
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (typeof entry !== "string") {
        warnings.push(`Ignored ${label}.${key}: expected text.`);
        return [];
      }
      const trimmed = entry.trim();
      return trimmed ? [[key, trimmed]] : [];
    })
  );
}

function resourceList(value: unknown, label: string, warnings: string[]): SetupResourceDraft[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Ignored ${label}: expected a resource list.`);
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`Skipped ${label} resource ${index + 1}: expected an object.`);
      return [];
    }

    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    const hasContent = Object.values(entry).some((item) => item !== undefined && item !== null && String(item).trim() !== "");
    if (!type) {
      if (hasContent) {
        warnings.push(`Skipped ${label} resource ${index + 1}: missing resource type.`);
      }
      return [];
    }
    if (!setupResourceTypes.includes(type as ArenaResourceType)) {
      warnings.push(`Skipped ${label} resource ${index + 1}: unsupported resource type "${type}".`);
      return [];
    }

    const namedEntry = {
      ...entry,
      type,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `${type} resource`
    };
    const parsed = setupResourceSchema.safeParse(namedEntry);
    if (!parsed.success) {
      warnings.push(`Skipped ${label} resource ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid resource"}.`);
      return [];
    }

    return [parsed.data];
  });
}

function resourceRecord(value: unknown, label: string, warnings: string[]): Record<string, SetupResourceDraft[]> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    warnings.push(`Ignored ${label}: expected an object keyed by id.`);
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, entries]) => [key, resourceList(entries, `${label}.${key}`, warnings)]));
}

function secretList(value: unknown, warnings: string[]): SetupSecretDraft[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push("Ignored secrets: expected a list.");
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`Skipped secret ${index + 1}: expected an object.`);
      return [];
    }
    const parsed = setupSecretSchema.safeParse(entry);
    if (!parsed.success) {
      warnings.push(`Skipped secret ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid secret"}.`);
      return [];
    }
    return [parsed.data];
  });
}

function normalizeSetupDraft(input: unknown, fallbackGoal = "Describe the task and measurable win condition here."): {
  draft: SetupDraft;
  warnings: string[];
} {
  const parsed = looseSetupDraftSchema.parse(input);
  const warnings: string[] = [];
  const goal = typeof parsed.goal === "string" && parsed.goal.trim() ? parsed.goal.trim() : fallbackGoal;
  if (!(typeof parsed.goal === "string" && parsed.goal.trim())) {
    warnings.push("Setup helper did not set a goal; using the current draft goal or placeholder.");
  }
  const verifyCommand = typeof parsed.verifyCommand === "string" && parsed.verifyCommand.trim() ? parsed.verifyCommand.trim() : undefined;
  let judging: JudgingConfig | undefined;
  if (isRecord(parsed.judging)) {
    if (parsed.judging.mode === "manual") {
      judging = { mode: "manual" };
    } else if (parsed.judging.mode === "verifier") {
      const command = typeof parsed.judging.verifyCommand === "string" ? parsed.judging.verifyCommand.trim() : "";
      if (command) {
        judging = {
          mode: "verifier",
          verifyCommand: command
        };
      } else {
        warnings.push("Ignored judging.verifier: missing verifyCommand.");
      }
    } else {
      warnings.push("Ignored judging: expected mode manual or verifier.");
    }
  } else if (parsed.judging !== undefined) {
    warnings.push("Ignored judging: expected an object.");
  }

  return {
    draft: {
      goal,
      // Older helper output may still emit a separate constraints list; fold
      // it into the single done-when list.
      successCriteria: [
        ...stringList(parsed.successCriteria, "success criteria", warnings),
        ...stringList(parsed.constraints, "constraints", warnings)
      ],
      verifyCommand,
      judging: judging ?? (verifyCommand ? { mode: "verifier", verifyCommand } : undefined),
      resources: resourceList(parsed.resources, "shared", warnings),
      teamInstructions: stringRecord(parsed.teamInstructions, "team instructions", warnings),
      teamResources: resourceRecord(parsed.teamResources, "team resources", warnings),
      agentInstructions: stringRecord(parsed.agentInstructions, "agent instructions", warnings),
      agentResources: resourceRecord(parsed.agentResources, "agent resources", warnings),
      secrets: secretList(parsed.secrets, warnings)
    },
    warnings
  };
}

function toResource(resource: z.infer<typeof setupResourceSchema>): ArenaResource {
  const value = resource.value;
  const envVar = resource.envVar ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(resource.name) ? resource.name : undefined);
  const datasetValueIsUrl = value?.startsWith("http://") || value?.startsWith("https://");
  const base = {
    optional: resource.optional,
    description: resource.description,
    usage: resource.usage,
    whenToUse: resource.whenToUse,
    budget: resource.budget,
    cleanup: resource.cleanup,
    verification: resource.verification,
    notes: resource.notes
  };

  switch (resource.type) {
    case "env":
      return {
        type: "env",
        name: resource.name,
        ...base,
        envVar
      };
    case "ssh":
      return {
        type: "ssh",
        name: resource.name,
        ...base,
        host: resource.host ?? value ?? resource.name,
        user: resource.user
      };
    case "gpu":
      return {
        type: "gpu",
        name: resource.name,
        ...base,
        host: resource.host ?? value
      };
    case "url":
      return {
        type: "url",
        name: resource.name,
        ...base,
        url: resource.url ?? value ?? resource.name
      };
    case "file":
      return {
        type: "file",
        name: resource.name,
        ...base,
        path: resource.path ?? value ?? resource.name
      };
    case "cloud":
      return {
        type: "cloud",
        name: resource.name,
        ...base,
        provider: resource.provider ?? value
      };
    case "dataset":
      return {
        type: "dataset",
        name: resource.name,
        ...base,
        path: resource.path ?? (datasetValueIsUrl ? undefined : value),
        url: resource.url ?? (datasetValueIsUrl ? value : undefined)
      };
    case "note":
      return {
        type: "note",
        name: resource.name,
        ...base,
        notes: resource.notes ?? value ?? resource.description ?? resource.name
      };
  }
}

function uniqueEnvResources(resources: ArenaResource[]): ArenaResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    if (resource.type !== "env" || !resource.envVar) {
      return true;
    }

    if (seen.has(resource.envVar)) {
      return false;
    }
    seen.add(resource.envVar);
    return true;
  });
}

function redactSetupDraft(draft: SetupDraft): SetupDraft {
  return {
    ...draft,
    secrets: draft.secrets.map((secret) => ({
      ...secret,
      value: secret.value === undefined ? undefined : "[redacted]"
    }))
  };
}

function resourcePreview(resource: ArenaResource): string {
  const parts = [resource.name, `type=${resource.type}`];
  if (resource.type === "env") {
    parts.push(`env=${resource.envVar}`);
  } else if (resource.type === "url") {
    parts.push(`url=${resource.url}`);
  } else if (resource.type === "file" || resource.type === "dataset") {
    if (resource.path) {
      parts.push(`path=${resource.path}`);
    }
    if (resource.url) {
      parts.push(`url=${resource.url}`);
    }
  } else if (resource.type === "ssh" || resource.type === "gpu") {
    if (resource.host) {
      parts.push(`host=${resource.host}`);
    }
  } else if (resource.type === "cloud" && resource.provider) {
    parts.push(`provider=${resource.provider}`);
  }
  if (resource.usage) {
    parts.push(`use=${resource.usage}`);
  }
  if (resource.whenToUse) {
    parts.push(`when=${resource.whenToUse}`);
  }
  return `- ${parts.join("; ")}`;
}

function setupContractText(draft: SetupDraft): string {
  const sharedResources = uniqueEnvResources([
    ...draft.resources.map(toResource),
    ...draft.secrets.map((secret) => ({
      type: "env" as const,
      name: secret.name ?? secret.envVar,
      envVar: secret.envVar,
      description: "Secret env var captured for agents."
    }))
  ]);

  const lines = [
    "AGENT ARENA SETUP DRAFT",
    "",
    "Objective:",
    draft.goal,
    "",
    "Judging:",
    draft.judging?.mode === "verifier"
      ? `- verifier: ${draft.judging.verifyCommand}`
      : draft.verifyCommand
        ? `- verifier: ${draft.verifyCommand}`
        : "- current Arena mode",
    "",
    "Done when:",
    ...(draft.successCriteria.length > 0 ? draft.successCriteria.map((item) => `- ${item}`) : ["- none yet"]),
    "",
    "Shared resources:",
    ...(sharedResources.length > 0 ? sharedResources.map(resourcePreview) : ["- none yet"]),
    "",
    "Team resources:",
    ...Object.entries(draft.teamResources).flatMap(([teamId, resources]) => [
      `- ${teamId}:`,
      ...(resources.length > 0 ? resources.map((resource) => `  ${resourcePreview(toResource(resource))}`) : ["  - none"])
    ]),
    ...(Object.keys(draft.teamResources).length === 0 ? ["- none yet"] : []),
    "",
    "Agent resources:",
    ...Object.entries(draft.agentResources).flatMap(([agentId, resources]) => [
      `- ${agentId}:`,
      ...(resources.length > 0 ? resources.map((resource) => `  ${resourcePreview(toResource(resource))}`) : ["  - none"])
    ]),
    ...(Object.keys(draft.agentResources).length === 0 ? ["- none yet"] : []),
    "",
    "Team notes:",
    ...(Object.entries(draft.teamInstructions).length > 0
      ? Object.entries(draft.teamInstructions).map(([teamId, value]) => `- ${teamId}: ${value}`)
      : ["- none yet"]),
    "",
    "Agent notes:",
    ...(Object.entries(draft.agentInstructions).length > 0
      ? Object.entries(draft.agentInstructions).map(([agentId, value]) => `- ${agentId}: ${value}`)
      : ["- none yet"]),
    "",
    "Secrets:",
    ...(draft.secrets.length > 0 ? draft.secrets.map((secret) => `- ${secret.envVar}: [redacted]`) : ["- none yet"]),
    "",
    "Press Ctrl-b then arrow keys to move panes. This pane updates from .agent-arena/setup-draft.json."
  ];

  return `${lines.join("\n")}\n`;
}

export async function renderSetupDraftPreview(repoRoot: string, view: SetupDraftPreviewView): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(setupDraftPath(repoRoot), "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [
        "AGENT ARENA SETUP DRAFT",
        "",
        "Waiting for helper output...",
        "",
        `Expected file: ${setupDraftPath(repoRoot)}`,
        "",
        "The helper should write setup-draft.json last, after any setup secret file."
      ].join("\n");
    }
    throw error;
  }

  const normalized = normalizeSetupDraft(JSON.parse(raw));
  const draft = normalized.draft;
  if (view === "json") {
    return `${JSON.stringify(redactSetupDraft(draft), null, 2)}\n`;
  }

  const warnings =
    normalized.warnings.length > 0 ? `\nImport warnings:\n${normalized.warnings.map((warning) => `- ${warning}`).join("\n")}\n` : "";
  return `${setupContractText(draft)}${warnings}`;
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeEnvFile(filePath: string, env: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serializeEnvFile(env), {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.chmod(filePath, 0o600);
}

export async function ensureAgentArenaIgnored(repoRoot: string): Promise<void> {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  if (!existing.split(/\r?\n/).includes(".agent-arena/")) {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}.agent-arena/\n`, "utf8");
  }
}

export async function createNewProject(targetPath: string): Promise<NewProjectResult> {
  const repoRoot = path.resolve(targetPath);
  const warnings: string[] = [];

  await fs.mkdir(repoRoot, { recursive: true });
  const entries = await fs.readdir(repoRoot);
  if (entries.length > 0) {
    throw new Error(`${repoRoot} already exists and is not empty.`);
  }

  runChecked("git", ["init"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), `# ${path.basename(repoRoot)}\n\nCreated by Agent Arena.\n`, "utf8");
  await fs.writeFile(path.join(repoRoot, ".gitignore"), ".agent-arena/\n", "utf8");

  try {
    runChecked("git", ["add", "README.md", ".gitignore"], repoRoot);
    runChecked(
      "git",
      [
        "-c",
        "user.name=Agent Arena",
        "-c",
        "user.email=agent-arena@example.invalid",
        "commit",
        "-m",
        "Initial Agent Arena project"
      ],
      repoRoot
    );
  } catch (error) {
    warnings.push(`Created project, but initial commit failed: ${(error as Error).message}`);
  }

  return {
    repoRoot,
    warnings
  };
}

export function selectSetupHelper(
  selectedAgents: AgentPresetId[],
  exists: (binary: string) => boolean = commandExists
): AgentPresetId | undefined {
  const ordered: AgentPresetId[] = selectedAgents.includes("codex")
    ? ["codex", ...selectedAgents.filter((agent) => agent !== "codex")]
    : selectedAgents;

  return ordered.find((agent) => {
    return builtInAgentIds.includes(agent) && exists(agentPresets[agent].binary);
  });
}

function helperCommand(helper: AgentPresetId, prompt: string): string {
  const withPath = (command: string): string =>
    process.env.PATH ? `env PATH=${shellQuote(process.env.PATH)} ${command}` : command;

  switch (helper) {
    case "claude":
      return withPath(`claude --permission-mode bypassPermissions ${shellQuote(prompt)}`);
    case "codex":
      return withPath(`codex --dangerously-bypass-approvals-and-sandbox ${shellQuote(prompt)}`);
    case "cursor":
      return withPath(`cursor-agent -p ${shellQuote(prompt)}`);
  }
}

export async function writeSetupCompletionTool(repoRoot: string, sessionName: string): Promise<string> {
  const completePath = setupCompletionPath(repoRoot);
  const draftPath = setupDraftPath(repoRoot);
  const script = [
    "#!/bin/sh",
    "set -eu",
    `DRAFT=${shellQuote(draftPath)}`,
    `SESSION=${shellQuote(sessionName)}`,
    `NODE=${shellQuote(process.execPath)}`,
    "",
    "if [ ! -s \"$DRAFT\" ]; then",
    "  echo \"Agent Arena setup draft is missing or empty: $DRAFT\" >&2",
    "  exit 1",
    "fi",
    "",
    "\"$NODE\" -e 'const fs = require(\"fs\"); JSON.parse(fs.readFileSync(process.argv[1], \"utf8\"));' \"$DRAFT\"",
    "echo \"Agent Arena setup draft is valid. Closing this helper session and returning to Arena review...\"",
    "",
    "if command -v tmux >/dev/null 2>&1; then",
    "  (sleep 0.2; tmux kill-session -t \"$SESSION\" >/dev/null 2>&1 || true) &",
    "fi",
    "",
    "exit 0",
    ""
  ].join("\n");

  await fs.mkdir(path.dirname(completePath), { recursive: true });
  await fs.writeFile(completePath, script, {
    encoding: "utf8",
    mode: 0o700
  });
  await fs.chmod(completePath, 0o700);
  return completePath;
}

export async function writeSetupAutoExitWatcher(
  repoRoot: string,
  sessionName: string,
  helperPane?: string
): Promise<string> {
  const watcherPath = setupAutoExitPath(repoRoot);
  const draftPath = setupDraftPath(repoRoot);
  const script = [
    "#!/bin/sh",
    "set -eu",
    `DRAFT=${shellQuote(draftPath)}`,
    `SESSION=${shellQuote(sessionName)}`,
    `PANE=${shellQuote(helperPane ?? "")}`,
    `NODE=${shellQuote(process.execPath)}`,
    "",
    "while :; do",
    "  if command -v tmux >/dev/null 2>&1 && ! tmux has-session -t \"$SESSION\" >/dev/null 2>&1; then",
    "    exit 0",
    "  fi",
    "",
    "  if [ -s \"$DRAFT\" ] && \"$NODE\" -e 'const fs = require(\"fs\"); JSON.parse(fs.readFileSync(process.argv[1], \"utf8\"));' \"$DRAFT\" >/dev/null 2>&1; then",
    "    if command -v tmux >/dev/null 2>&1; then",
    "      tmux send-keys -t \"$SESSION\" \"/exit\" Enter >/dev/null 2>&1 || true",
    "      sleep 1",
    "      tmux kill-session -t \"$SESSION\" >/dev/null 2>&1 || true",
    "    fi",
    "    exit 0",
    "  fi",
    "",
    "  # The draft-watch pane keeps the session alive after the helper CLI",
    "  # exits; if the helper pane is gone and no draft was written, collapse",
    "  # the session instead of leaving 'Waiting for helper output...' forever.",
    "  if [ -n \"$PANE\" ] && command -v tmux >/dev/null 2>&1; then",
    "    if ! tmux list-panes -t \"$SESSION\" -F '#{pane_id}' 2>/dev/null | grep -qxF \"$PANE\"; then",
    "      tmux kill-session -t \"$SESSION\" >/dev/null 2>&1 || true",
    "      exit 0",
    "    fi",
    "  fi",
    "",
    "  sleep 1",
    "done",
    ""
  ].join("\n");

  await fs.mkdir(path.dirname(watcherPath), { recursive: true });
  await fs.writeFile(watcherPath, script, {
    encoding: "utf8",
    mode: 0o700
  });
  await fs.chmod(watcherPath, 0o700);
  return watcherPath;
}

export function buildSetupPrompt(
  repoRoot: string,
  selectedAgents: AgentPresetId[],
  completionToolPath: string,
  feedback?: string,
  priorDraft?: TuiDraft
): string {
  const draftPath = setupDraftPath(repoRoot);
  const secretsFile = setupSecretsPath(repoRoot);
  return [
    "You are the Agent Arena setup helper.",
    "",
    "Talk with the user in this native CLI session. Let them ramble naturally about what they want the competing agents to do. Ask clarifying questions only when needed.",
    "You may inspect and research the project to turn the user's intent into a concrete arena setup.",
    "You may run project commands and install setup-only probe dependencies under .agent-arena/setup/ to discover a real verifier command.",
    "",
    "Rules:",
    "- Do not edit project source files, tests, package manifests, or config files outside .agent-arena/.",
    "- You may write setup-only files under .agent-arena/setup/.",
    `- Write the final structured draft only to ${draftPath}.`,
    `- If you create a verifier helper, write it to ${setupVerifierPath(repoRoot)}. Arena will copy it into each workspace as .arena/verifier.sh.`,
    "- Prefer verifier judging for objective coding tasks. Include either verifyCommand or judging.mode=\"verifier\" with a verifyCommand.",
    `- If the user gives any API key, token, password, or raw secret value, write it only to ${secretsFile} as KEY=value lines or put the redacted env var name in the secrets array.`,
    "- Never put raw secret values in setup-draft.json.",
    "- If a task depends on a secret-backed env var, add both a resources entry with type env and a secrets entry using the same envVar name.",
    "- For every resource that agents should use, fill usage and whenToUse. Add budget, cleanup, and verification when relevant.",
    "- If the task does not need resources, secrets, team resources, or agent resources, use empty arrays/objects. Do not add placeholder resource cards.",
    "- Resource order fields mean: usage = what agents should do with it, whenToUse = trigger conditions, budget = limits, cleanup = shutdown/revocation steps, verification = how agents prove it is ready or was used correctly.",
    "- Write any setup secret file before setup-draft.json; setup-draft.json is the completion signal and should be written last.",
    `- When the draft is ready, your final action must be to run this completion/exit tool: ${completionToolPath}`,
    "- Do not run the completion tool until setup-draft.json exists and contains valid JSON.",
    "- Use your shell/tool runner to execute the completion/exit tool yourself. Do not ask the user to run /exit, detach tmux, or close the session.",
    "- After calling the completion/exit tool, do not continue chatting. The tool validates the JSON and closes this helper session so Agent Arena can import the draft.",
    "",
    `Selected competitor harnesses: ${selectedAgents.join(", ")}`,
    "Use exact team ids and agent ids shown by Arena when the user mentions a specific team or agent. If no ids are known, use harness names only as a fallback.",
    feedback ? `User feedback for this revision: ${feedback}` : undefined,
    priorDraft ? `Current draft to revise:\n${JSON.stringify(priorDraft, null, 2)}` : undefined,
    "",
    "setup-draft.json must be valid JSON with this shape:",
    JSON.stringify(
      {
        goal: "One clear objective.",
        successCriteria: ["Concrete done-when checkpoint the captain verifies before claiming."],
        verifyCommand: "python3 verify.py",
        judging: {
          mode: "verifier",
          verifyCommand: "python3 verify.py"
        },
        resources: [
          {
            type: "env",
            name: "API key",
            optional: false,
            envVar: "OPENAI_API_KEY",
            description: "Redacted secret available from env.",
            usage: "Use this API key for the service calls needed by the task.",
            whenToUse: "Use when local-only work cannot satisfy the objective.",
            budget: "Stay within the user's stated budget.",
            cleanup: "Do not print, commit, or expose the key.",
            verification: "Run the relevant auth or smoke command without printing the secret value."
          }
        ],
        teamInstructions: {
          red: "Special instructions for Team Red."
        },
        teamResources: {
          red: []
        },
        agentInstructions: {
          "red-codex": "Special instructions for this exact Codex agent.",
          codex: "Fallback instructions for Codex harnesses when exact ids are unknown."
        },
        agentResources: {
          "red-codex": []
        },
        secrets: [
          {
            name: "Optional display name",
            envVar: "SERVICE_API_KEY"
          }
        ]
      },
      null,
      2
    )
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function captureProjectSignature(repoRoot: string): string {
  const status = runChecked("git", ["status", "--short", "--untracked-files=all"], repoRoot);
  const diff = runChecked("git", ["diff", "--stat"], repoRoot);
  const cached = runChecked("git", ["diff", "--cached", "--stat"], repoRoot);
  return [status, diff, cached].join("\n---\n");
}

function gitStatus(repoRoot: string): string {
  return runChecked("git", ["status", "--short", "--untracked-files=all"], repoRoot);
}

export function projectChangesSince(repoRoot: string, signature: string): string | undefined {
  return captureProjectSignature(repoRoot) === signature ? undefined : gitStatus(repoRoot);
}

async function mergeSetupSecrets(repoRoot: string, setupDraft: SetupDraft): Promise<Record<string, string>> {
  const explicitSecrets = Object.fromEntries(
    setupDraft.secrets
      .filter((secret) => secret.value !== undefined)
      .map((secret) => [secret.envVar, secret.value as string])
  );
  const setupSecrets = await readEnvFile(setupSecretsPath(repoRoot));
  const currentSecrets = await readEnvFile(secretsPath(repoRoot));
  const merged = {
    ...currentSecrets,
    ...setupSecrets,
    ...explicitSecrets
  };

  if (Object.keys(merged).length > 0) {
    await writeEnvFile(secretsPath(repoRoot), merged);
  }

  return merged;
}

export async function importSetupDraft(
  repoRoot: string,
  selectedAgents: AgentPresetId[],
  baseDraft: TuiDraft = emptyDraft()
): Promise<{ draft: TuiDraft; warnings: string[] }> {
  const raw = await fs.readFile(setupDraftPath(repoRoot), "utf8");
  const sourceDraft = baseDraft.agents.length > 0 ? baseDraft : draftFromSelectedPresets(selectedAgents);
  const normalized = normalizeSetupDraft(JSON.parse(raw), sourceDraft.goal || "Describe the task and measurable win condition here.");
  const setupDraft = normalized.draft;
  let setupVerifierExists = false;
  try {
    await fs.access(setupVerifierPath(repoRoot));
    setupVerifierExists = true;
  } catch {
    setupVerifierExists = false;
  }
  const judging =
    setupVerifierExists
      ? ({
          mode: "verifier",
          verifyCommand: "./.arena/verifier.sh"
        } as const)
      : setupDraft.judging ?? (setupDraft.verifyCommand ? ({ mode: "verifier", verifyCommand: setupDraft.verifyCommand } as const) : sourceDraft.judging);
  const secrets = await mergeSetupSecrets(repoRoot, setupDraft);
  const secretResources: ArenaResource[] = setupDraft.secrets.map((secret) => ({
    type: "env",
    name: secret.name ?? secret.envVar,
    envVar: secret.envVar,
    description: secrets[secret.envVar] !== undefined ? "Configured in .agent-arena/secrets.env." : "Secret value not configured."
  }));

  const teams = sourceDraft.teams.map((team) => ({
    ...team,
    instructions: setupDraft.teamInstructions[team.id] ?? team.instructions,
    resources: setupDraft.teamResources[team.id]?.map(toResource) ?? team.resources
  }));

  const agents = sourceDraft.agents.map((agent) => {
    const exactInstructions = setupDraft.agentInstructions[agent.id];
    const presetInstructions = agent.preset ? setupDraft.agentInstructions[agent.preset] : undefined;
    const exactResources = setupDraft.agentResources[agent.id];
    const presetResources = agent.preset ? setupDraft.agentResources[agent.preset] : undefined;

    return {
      ...agent,
      instructions: exactInstructions ?? presetInstructions ?? agent.instructions,
      resources: exactResources?.map(toResource) ?? presetResources?.map(toResource) ?? agent.resources
    };
  });

  return {
    draft: {
      ...sourceDraft,
      teams,
      agents,
      goal: setupDraft.goal,
      successCriteria: setupDraft.successCriteria,
      resources: uniqueEnvResources([...setupDraft.resources.map(toResource), ...secretResources]),
      judging
    },
    warnings: normalized.warnings
  };
}

export async function launchSetupHelper(options: {
  repoRoot: string;
  selectedAgents: AgentPresetId[];
  helper: AgentPresetId;
  cliPath?: string;
  feedback?: string;
  priorDraft?: TuiDraft;
}): Promise<SetupHelperResult> {
  await ensureAgentArenaIgnored(options.repoRoot);
  await fs.mkdir(path.join(options.repoRoot, ".agent-arena"), { recursive: true });
  await fs.rm(setupDraftPath(options.repoRoot), { force: true });

  const sessionName = `agent-arena-setup-${Date.now().toString(36)}`;
  const completionToolPath = await writeSetupCompletionTool(options.repoRoot, sessionName);
  const before = captureProjectSignature(options.repoRoot);
  const prompt = buildSetupPrompt(
    options.repoRoot,
    options.selectedAgents,
    completionToolPath,
    options.feedback,
    options.priorDraft
  );
  const command = helperCommand(options.helper, prompt);
  const cliPath = options.cliPath ?? process.env.AGENT_ARENA_CLI_PATH ?? process.argv[1];
  const draftWatcherCommand = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} tui draft-watch --repo ${shellQuote(
    options.repoRoot
  )} --view contract`;

  const create = spawnSync("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sessionName, "-n", "setup", "-c", options.repoRoot, command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (create.status !== 0) {
    return {
      ok: false,
      warnings: [`Could not launch setup helper: ${create.stderr.trim() || "tmux failed"}`]
    };
  }
  const helperPane = create.stdout.trim();
  const watcher = spawnSync("tmux", ["split-window", "-h", "-p", "42", "-t", helperPane, "-c", options.repoRoot, draftWatcherCommand], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (watcher.status !== 0) {
    spawnSync("tmux", ["kill-session", "-t", sessionName], {
      encoding: "utf8"
    });
    return {
      ok: false,
      warnings: [`Could not launch setup draft watcher: ${watcher.stderr.trim() || "tmux split failed"}`]
    };
  }
  spawnSync("tmux", ["select-pane", "-t", helperPane], {
    encoding: "utf8"
  });

  // Written after the helper pane exists so the watcher can detect its death.
  const autoExitPath = await writeSetupAutoExitWatcher(options.repoRoot, sessionName, helperPane);
  const autoExit = spawn("sh", [autoExitPath], {
    detached: true,
    stdio: "ignore"
  });
  autoExit.unref();

  const attached = attachTmuxSession(sessionName, "auto");
  if (!attached.attached && !attached.launchedExternal && !attached.openedInTmux) {
    return {
      ok: false,
      warnings: attached.warnings
    };
  }
  if (attached.launchedExternal || attached.openedInTmux) {
    await waitForSetupHelper(options.repoRoot, sessionName, helperPane);
  }

  const blockedChanges = projectChangesSince(options.repoRoot, before);
  if (blockedChanges !== undefined) {
    return {
      ok: false,
      warnings: ["Setup helper changed project files outside allowed setup outputs."],
      blockedChanges
    };
  }

  try {
    const imported = await importSetupDraft(options.repoRoot, options.selectedAgents, options.priorDraft);
    return {
      ok: true,
      draft: imported.draft,
      warnings: imported.warnings
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      warnings: [
        code === "ENOENT"
          ? "The setup helper ended without saving a draft. Rerun it or fill in the task manually."
          : `Setup helper did not produce a valid draft: ${(error as Error).message}`
      ]
    };
  }
}
