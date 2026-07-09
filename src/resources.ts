import fs from "node:fs";
import path from "node:path";
import type { ArenaResource } from "./types.js";

export type ResourceAvailabilityStatus = "available" | "missing" | "declared";
export type ResourceAvailabilitySource = "agent env" | "process env" | "saved secret" | "file" | "manual";

export type ResourceAvailabilityContext = {
  processEnv?: Record<string, string | undefined>;
  savedSecrets?: Record<string, string | undefined>;
  agentEnv?: Record<string, string | undefined>;
  baseDir?: string;
};

export type ResourceAvailability = {
  resource: ArenaResource;
  status: ResourceAvailabilityStatus;
  source: ResourceAvailabilitySource;
  required: boolean;
  blocking: boolean;
  message: string;
};

function parts(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(", ");
}

export function describeResource(resource: ArenaResource): string {
  const suffix = parts([
    resource.optional ? "optional" : undefined,
    resource.envVar ? `env: ${resource.envVar}` : undefined,
    resource.host ? `host: ${resource.host}` : undefined,
    resource.user ? `user: ${resource.user}` : undefined,
    resource.path ? `path: ${resource.path}` : undefined,
    resource.url ? `url: ${resource.url}` : undefined,
    resource.provider ? `provider: ${resource.provider}` : undefined,
    resource.description,
    resource.usage ? `usage: ${resource.usage}` : undefined,
    resource.whenToUse ? `when: ${resource.whenToUse}` : undefined,
    resource.budget ? `budget: ${resource.budget}` : undefined,
    resource.notes
  ]);

  return suffix ? `${resource.name} (${resource.type}; ${suffix})` : `${resource.name} (${resource.type})`;
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function resolvePath(resourcePath: string, baseDir?: string): string {
  return path.isAbsolute(resourcePath) || !baseDir ? resourcePath : path.join(baseDir, resourcePath);
}

function pathExists(resourcePath: string, baseDir?: string): boolean {
  try {
    fs.accessSync(resolvePath(resourcePath, baseDir));
    return true;
  } catch {
    return false;
  }
}

function envAvailability(resource: ArenaResource, context: ResourceAvailabilityContext): ResourceAvailability {
  const required = !resource.optional;
  const envVar = resource.envVar;
  if (!envVar) {
    return {
      resource,
      status: "missing",
      source: "manual",
      required,
      blocking: required,
      message: `Env resource "${resource.name}" is missing an envVar name.`
    };
  }

  if (hasValue(context.agentEnv?.[envVar])) {
    return {
      resource,
      status: "available",
      source: "agent env",
      required,
      blocking: false,
      message: `${envVar} is available from per-agent env.`
    };
  }

  if (hasValue(context.savedSecrets?.[envVar])) {
    return {
      resource,
      status: "available",
      source: "saved secret",
      required,
      blocking: false,
      message: `${envVar} is available from saved secret.`
    };
  }

  if (hasValue((context.processEnv ?? process.env)[envVar])) {
    return {
      resource,
      status: "available",
      source: "process env",
      required,
      blocking: false,
      message: `${envVar} is available from process env.`
    };
  }

  return {
    resource,
    status: "missing",
    source: "manual",
    required,
    blocking: required,
    message: `${envVar} is missing for ${required ? "required" : "optional"} resource "${resource.name}".`
  };
}

function pathAvailability(resource: ArenaResource, context: ResourceAvailabilityContext): ResourceAvailability {
  const required = !resource.optional;
  const resourcePath = resource.path;
  if (!resourcePath) {
    return {
      resource,
      status: "declared",
      source: "manual",
      required,
      blocking: false,
      message: `${resource.name} is declared; no local path was provided for automatic checking.`
    };
  }

  const exists = pathExists(resourcePath, context.baseDir);
  return {
    resource,
    status: exists ? "available" : "missing",
    source: exists ? "file" : "manual",
    required,
    blocking: required && !exists,
    message: exists
      ? `${resourcePath} exists.`
      : `${resourcePath} is missing for ${required ? "required" : "optional"} resource "${resource.name}".`
  };
}

export function resolveResourceAvailability(
  resource: ArenaResource,
  context: ResourceAvailabilityContext = {}
): ResourceAvailability {
  switch (resource.type) {
    case "env":
      return envAvailability(resource, context);
    case "file":
      return pathAvailability(resource, context);
    case "dataset":
      return resource.path
        ? pathAvailability(resource, context)
        : {
            resource,
            status: "declared",
            source: "manual",
            required: !resource.optional,
            blocking: false,
            message: `${resource.name} is declared; dataset availability must be checked manually.`
          };
    case "cloud":
    case "gpu":
    case "ssh":
    case "url":
    case "note":
      return {
        resource,
        status: "declared",
        source: "manual",
        required: !resource.optional,
        blocking: false,
        message: `${resource.name} is declared; ${resource.type} resources require manual/provider-specific handling.`
      };
  }
}

export function resolveResourcesAvailability(
  resources: ArenaResource[],
  context: ResourceAvailabilityContext = {}
): ResourceAvailability[] {
  return resources.map((resource) => resolveResourceAvailability(resource, context));
}

export function describeAvailability(availability: ResourceAvailability): string {
  const required = availability.required ? "required" : "optional";
  if (availability.status === "available") {
    return `${required}, available from ${availability.source}`;
  }
  if (availability.status === "missing") {
    return `${required}, missing`;
  }
  return `${required}, declared/manual-check`;
}

export function resourceWarnings(
  resources: ArenaResource[],
  label = "resource",
  context: ResourceAvailabilityContext = {}
): string[] {
  return resolveResourcesAvailability(resources, context)
    .filter((availability) => availability.status === "missing")
    .map((availability) => `${availability.message} (${label})`);
}

export function resourceBlockingErrors(
  resources: ArenaResource[],
  label = "resource",
  context: ResourceAvailabilityContext = {}
): string[] {
  return resolveResourcesAvailability(resources, context)
    .filter((availability) => availability.blocking)
    .map((availability) => `${availability.message} (${label})`);
}

export function hasResourceUsageDirective(resource: ArenaResource): boolean {
  return Boolean(resource.usage?.trim() || resource.whenToUse?.trim());
}

export function resourceOrderWarnings(resources: ArenaResource[], label = "resource"): string[] {
  return resources.flatMap((resource) => {
    if (resource.type === "note" || hasResourceUsageDirective(resource)) {
      return [];
    }

    return [
      `${label} "${resource.name}" has no usage or whenToUse directive; agents may treat it as passive context instead of using it.`
    ];
  });
}

export function resourceOrderLines(resource: ArenaResource): string[] {
  const lines = [
    `### ${resource.name}`,
    "",
    `- Type: ${resource.type}`,
    `- Required: ${resource.optional ? "no" : "yes"}`,
    resource.envVar ? `- Env var: ${resource.envVar}` : undefined,
    resource.host ? `- Host: ${resource.host}` : undefined,
    resource.user ? `- User: ${resource.user}` : undefined,
    resource.path ? `- Path: ${resource.path}` : undefined,
    resource.url ? `- URL: ${resource.url}` : undefined,
    resource.provider ? `- Provider: ${resource.provider}` : undefined,
    resource.description ? `- Description: ${resource.description}` : undefined,
    resource.usage ? `- Usage: ${resource.usage}` : "- Usage: Not specified; infer from the objective and ask/stop if this resource seems necessary but unclear.",
    resource.whenToUse
      ? `- When to use: ${resource.whenToUse}`
      : "- When to use: Not specified; if local capabilities are insufficient and this resource appears relevant, use it or explain why it is not needed.",
    resource.budget ? `- Budget/limits: ${resource.budget}` : undefined,
    resource.cleanup ? `- Cleanup: ${resource.cleanup}` : undefined,
    resource.verification ? `- Verification: ${resource.verification}` : undefined,
    resource.notes ? `- Notes: ${resource.notes}` : undefined,
    ""
  ];

  return lines.filter((line): line is string => line !== undefined);
}

export function envFromResources(
  resources: ArenaResource[],
  context: ResourceAvailabilityContext = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const resource of resources) {
    if (resource.type !== "env" || !resource.envVar) {
      continue;
    }
    const value =
      context.agentEnv?.[resource.envVar] ??
      context.savedSecrets?.[resource.envVar] ??
      (context.processEnv ?? process.env)[resource.envVar];
    if (hasValue(value)) {
      env[resource.envVar] = value;
    }
  }
  return env;
}

export function resourceManifestEntry(
  availability: ResourceAvailability,
  scope: "shared" | "team" | "agent"
): Record<string, unknown> {
  const resource = availability.resource;
  return {
    scope,
    type: resource.type,
    name: resource.name,
    optional: Boolean(resource.optional),
    status: availability.status,
    source: availability.source,
    required: availability.required,
    blocking: availability.blocking,
    envVar: resource.envVar,
    host: resource.host,
    user: resource.user,
    path: resource.path,
    url: resource.url,
    provider: resource.provider,
    description: resource.description,
    usage: resource.usage,
    whenToUse: resource.whenToUse,
    budget: resource.budget,
    cleanup: resource.cleanup,
    verification: resource.verification,
    notes: resource.notes,
    message: availability.message
  };
}

export function parseEnvFile(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function serializeEnvFile(env: Record<string, string>): string {
  return `${Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value.replaceAll("\n", "\\n")}`)
    .join("\n")}\n`;
}

export function readSecretsEnv(arenaRoot: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(path.join(arenaRoot, "secrets.env"), "utf8"));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
