import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDE } from "./defaults.js";
import type { ArenaConfig, TeamInput } from "./types.js";

const DEFAULT_PEEK = {
  refreshIntervalSeconds: 30,
  include: DEFAULT_INCLUDE,
  exclude: DEFAULT_EXCLUDES
};

const DEFAULT_TMUX = {
  sessionPrefix: "agent-arena",
  attach: true
};

const agentIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, and hyphens.");
const teamIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, and hyphens.");
const goalModeSchema = z.enum(["auto", "goal", "prompt"]).default("auto");
const thinkingLevelSchema = z.enum(["auto", "low", "medium", "high", "max", "xhigh"]).default("auto");
const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name, not a raw secret value.");

const resourceBaseSchema = {
  name: z.string().min(1),
  optional: z.boolean().optional(),
  description: z.string().min(1).optional(),
  usage: z.string().min(1).optional(),
  whenToUse: z.string().min(1).optional(),
  budget: z.string().min(1).optional(),
  cleanup: z.string().min(1).optional(),
  verification: z.string().min(1).optional(),
  notes: z.string().min(1).optional()
};

const resourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("env"),
    ...resourceBaseSchema,
    envVar: envVarNameSchema
  }),
  z.object({
    type: z.literal("ssh"),
    ...resourceBaseSchema,
    host: z.string().min(1),
    user: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("gpu"),
    ...resourceBaseSchema,
    host: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("url"),
    ...resourceBaseSchema,
    url: z.string().min(1)
  }),
  z.object({
    type: z.literal("file"),
    ...resourceBaseSchema,
    path: z.string().min(1)
  }),
  z.object({
    type: z.literal("cloud"),
    ...resourceBaseSchema,
    provider: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("dataset"),
    ...resourceBaseSchema,
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("note"),
    ...resourceBaseSchema
  })
]);

const manualJudgingSchema = z.object({
  mode: z.literal("manual")
});

const verifierJudgingSchema = z.object({
  mode: z.literal("verifier"),
  verifyCommand: z.string().min(1),
  protectedPaths: z.array(z.string().min(1)).default([])
});

const judgingSchema = z.discriminatedUnion("mode", [manualJudgingSchema, verifierJudgingSchema]);

const agentSchema = z
  .object({
    id: agentIdSchema,
    name: z.string().min(1).optional(),
    codename: z.string().min(1).optional(),
    preset: z.enum(["claude", "codex", "cursor"]).optional(),
    command: z.string().min(1).optional(),
    goalMode: goalModeSchema,
    model: z.string().min(1).optional(),
    thinkingLevel: thinkingLevelSchema,
    env: z.record(z.string(), z.string()).optional(),
    instructions: z.string().optional(),
    resources: z.array(resourceSchema).default([])
  })
  .superRefine((agent, ctx) => {
    if (!agent.preset && !agent.command) {
      ctx.addIssue({
        code: "custom",
        message: "Agent must define either preset or command.",
        path: ["preset"]
      });
    }
  });

const teamSchema = z.object({
  id: teamIdSchema,
  name: z.string().min(1),
  captainAgentId: agentIdSchema,
  agentIds: z.array(agentIdSchema).min(1),
  instructions: z.string().optional(),
  resources: z.array(resourceSchema).default([])
});

const peekSchema = z
  .object({
    refreshIntervalSeconds: z.number().int().positive().default(30),
    include: z.array(z.string()).default(DEFAULT_INCLUDE),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDES)
  })
  .default(DEFAULT_PEEK);

const tmuxSchema = z
  .object({
    sessionPrefix: z.string().min(1).default("agent-arena"),
    attach: z.boolean().default(true)
  })
  .default(DEFAULT_TMUX);

export const arenaConfigSchema = z
  .object({
    baseRepo: z.string().min(1).default("."),
    baseRef: z.string().min(1).default("HEAD"),
    goal: z.string().min(1),
    successCriteria: z.array(z.string().min(1)).default([]),
    resources: z.array(resourceSchema).default([]),
    verifyCommand: z.string().min(1).optional(),
    judging: judgingSchema.optional(),
    teams: z.array(teamSchema).optional(),
    agents: z.array(agentSchema).min(2, "Agent Arena requires at least two agents."),
    peek: peekSchema,
    tmux: tmuxSchema
  })
  .superRefine((config, ctx) => {
    const ids = new Set(config.agents.map((agent) => agent.id));
    if (ids.size !== config.agents.length) {
      ctx.addIssue({
        code: "custom",
        message: "Agent ids must be unique.",
        path: ["agents"]
      });
    }

    if (ids.has("user")) {
      ctx.addIssue({
        code: "custom",
        message: 'Agent id "user" is reserved for the human director in arena chat.',
        path: ["agents"]
      });
    }

    const codenames = config.agents.flatMap((agent) => (agent.codename ? [agent.codename.trim().toLowerCase()] : []));
    if (new Set(codenames).size !== codenames.length) {
      ctx.addIssue({
        code: "custom",
        message: "Agent codenames must be unique.",
        path: ["agents"]
      });
    }

    if (!config.teams) {
      return;
    }

    if (config.teams.length < 2) {
      ctx.addIssue({
        code: "custom",
        message: "Team Arena requires at least two teams.",
        path: ["teams"]
      });
    }

    const teamIds = new Set(config.teams.map((team) => team.id));
    if (teamIds.size !== config.teams.length) {
      ctx.addIssue({
        code: "custom",
        message: "Team ids must be unique.",
        path: ["teams"]
      });
    }

    const agentIds = new Set(config.agents.map((agent) => agent.id));
    const membership = new Map<string, string>();
    for (const [teamIndex, team] of config.teams.entries()) {
      if (!team.agentIds.includes(team.captainAgentId)) {
        ctx.addIssue({
          code: "custom",
          message: `Captain ${team.captainAgentId} must belong to team ${team.id}.`,
          path: ["teams", teamIndex, "captainAgentId"]
        });
      }

      for (const agentId of team.agentIds) {
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown agent ${agentId} in team ${team.id}.`,
            path: ["teams", teamIndex, "agentIds"]
          });
          continue;
        }

        const existingTeam = membership.get(agentId);
        if (existingTeam) {
          ctx.addIssue({
            code: "custom",
            message: `Agent ${agentId} belongs to both ${existingTeam} and ${team.id}.`,
            path: ["teams", teamIndex, "agentIds"]
          });
        }
        membership.set(agentId, team.id);
      }
    }

    for (const agentId of agentIds) {
      if (!membership.has(agentId)) {
        ctx.addIssue({
          code: "custom",
          message: `Agent ${agentId} must belong to exactly one team.`,
          path: ["teams"]
        });
      }
    }
  })
  .transform((config): ArenaConfig => {
    const judging =
      config.judging ??
      (config.verifyCommand
        ? {
            mode: "verifier" as const,
            verifyCommand: config.verifyCommand
          }
        : { mode: "manual" as const });

    const teams: TeamInput[] =
      config.teams ??
      config.agents.map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        captainAgentId: agent.id,
        agentIds: [agent.id],
        resources: []
      }));

    return {
      ...config,
      judging,
      teams,
      verifyCommand: judging.mode === "verifier" ? judging.verifyCommand : config.verifyCommand
    };
  });

export function parseArenaConfig(input: unknown): ArenaConfig {
  return arenaConfigSchema.parse(input);
}

export async function readConfig(configPath: string): Promise<ArenaConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return parseArenaConfig(JSON.parse(raw));
}

export function defaultConfig(): ArenaConfig {
  return parseArenaConfig({
    baseRepo: ".",
    baseRef: "HEAD",
    goal: "Describe the task and measurable win condition here.",
    successCriteria: ["Describe how you will judge a successful solution."],
    resources: [],
    judging: {
      mode: "manual"
    },
    teams: [
      {
        id: "claude",
        name: "Team Claude",
        captainAgentId: "claude",
        agentIds: ["claude"],
        resources: []
      },
      {
        id: "codex",
        name: "Team Codex",
        captainAgentId: "codex",
        agentIds: ["codex"],
        resources: []
      }
    ],
    agents: [
      {
        id: "claude",
        preset: "claude",
        goalMode: "auto",
        resources: []
      },
      {
        id: "codex",
        preset: "codex",
        goalMode: "auto",
        resources: []
      }
    ],
    peek: {
      refreshIntervalSeconds: 30,
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDES
    },
    tmux: {
      sessionPrefix: "agent-arena",
      attach: true
    }
  });
}
