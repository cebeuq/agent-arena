export type AgentPresetId = "claude" | "codex" | "cursor";
export type GoalMode = "auto" | "goal" | "prompt";
export type AgentLaunchMode = "goal" | "prompt";
export type AgentThinkingLevel = "auto" | "low" | "medium" | "high" | "max" | "xhigh";
export type ArenaResourceType = "env" | "ssh" | "gpu" | "url" | "file" | "cloud" | "dataset" | "note";
export type ClaimStatus = "pending" | "accepted" | "rejected" | "passed" | "failed" | "ignored";

export type ArenaResource = {
  type: ArenaResourceType;
  name: string;
  optional?: boolean;
  description?: string;
  usage?: string;
  whenToUse?: string;
  budget?: string;
  cleanup?: string;
  verification?: string;
  envVar?: string;
  host?: string;
  user?: string;
  path?: string;
  url?: string;
  provider?: string;
  notes?: string;
};

export type ManualJudgingConfig = {
  mode: "manual";
};

export type VerifierJudgingConfig = {
  mode: "verifier";
  verifyCommand: string;
  // Paths restored from baseRef in the verification checkout before the
  // verifier runs, so agents cannot pass by editing the tests themselves.
  protectedPaths?: string[];
};

export type JudgingConfig = ManualJudgingConfig | VerifierJudgingConfig;

export type CompetitionRuntimeStatus = {
  lastDirectorUpdate?: string;
  lastNoticeAt?: string;
  lastNoticeReason?: string;
};

export type TeamInput = {
  id: string;
  name: string;
  captainAgentId: string;
  agentIds: string[];
  instructions?: string;
  resources?: ArenaResource[];
};

export type AgentInput = {
  id: string;
  name?: string;
  codename?: string;
  preset?: AgentPresetId;
  command?: string;
  goalMode: GoalMode;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  env?: Record<string, string>;
  instructions?: string;
  resources?: ArenaResource[];
};

export type PeekConfig = {
  refreshIntervalSeconds: number;
  include: string[];
  exclude: string[];
};

export type TmuxConfig = {
  sessionPrefix: string;
  attach: boolean;
};

export type ArenaConfig = {
  baseRepo: string;
  baseRef: string;
  goal: string;
  successCriteria: string[];
  resources: ArenaResource[];
  verifyCommand?: string;
  judging: JudgingConfig;
  teams: TeamInput[];
  agents: AgentInput[];
  peek: PeekConfig;
  tmux: TmuxConfig;
};

export type AgentPreset = {
  id: AgentPresetId;
  displayName: string;
  binary: string;
  promptCommand: string;
  goalCommand?: string;
  goalMinimumVersion?: string;
  goalUnsupportedReason?: string;
  installHint: string;
  authHint: string;
  docsUrl: string;
};

export type AgentGoalCapability = {
  supported: boolean;
  reason?: string;
  detectedVersion?: string;
  minimumVersion?: string;
  // True when the CLI's version could not be read or parsed at all, as
  // opposed to a version that is known to be too old. Newer CLI releases can
  // change --version output, so this signals "check the gate" not "missing".
  detectionFailed?: boolean;
};

export type RunTeam = {
  id: string;
  name: string;
  captainAgentId: string;
  agentIds: string[];
  instructions?: string;
  resources: ArenaResource[];
};

export type RunAgent = {
  id: string;
  name: string;
  codename: string;
  teamId: string;
  teamName: string;
  captainAgentId: string;
  isCaptain: boolean;
  preset?: AgentPresetId;
  binary?: string;
  command: string;
  configuredGoalMode: GoalMode;
  launchMode: AgentLaunchMode;
  launchNote?: string;
  goalCapability?: AgentGoalCapability;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  env?: Record<string, string>;
  instructions?: string;
  teamInstructions?: string;
  teamResources: ArenaResource[];
  resources: ArenaResource[];
  workspace: string;
  branch: string;
  goalFile: string;
  briefFile: string;
  claimScript: string;
  claimCommand: string;
  chatScript: string;
  chatCommand: string;
  chatInboxCommand: string;
  chatHistoryCommand: string;
  proposePatchScript: string;
  proposePatchCommand: string;
  applyProposalScript: string;
  applyProposalCommand: string;
  rivalsDir: string;
  rivalDirs: Record<string, string>;
  paneId?: string;
};

export type ClaimRecord = {
  agentId: string;
  teamId?: string;
  claimedAt: string;
  verifiedAt?: string;
  status: ClaimStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  note?: string;
};

export type WinnerRecord = {
  teamId?: string;
  agentId: string;
  claimedAt: string;
  verifiedAt: string;
  elapsedMs: number;
};

export type HarvestRecord = {
  harvestedAt: string;
  agentId: string;
  branch: string;
  snapshotCommit: string;
  merged: boolean;
  mergeCommit?: string;
  targetBranch?: string;
};

export type RunState = {
  runId: string;
  status: "running" | "finished" | "stopped";
  startedAt: string;
  finishedAt?: string;
  baseRepo: string;
  baseRef: string;
  arenaRoot: string;
  runDir: string;
  statePath: string;
  goal: string;
  successCriteria: string[];
  resources: ArenaResource[];
  verifyCommand?: string;
  judging: JudgingConfig;
  competitionStatus?: CompetitionRuntimeStatus;
  teams?: RunTeam[];
  peek: PeekConfig;
  tmux: {
    sessionName: string;
    attach: boolean;
  };
  mirrorDaemonPid?: number;
  agents: RunAgent[];
  claims: ClaimRecord[];
  winner?: WinnerRecord;
  harvest?: HarvestRecord;
};

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
