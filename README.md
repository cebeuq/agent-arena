# Agent Arena 

Agent Arena runs coding-agent CLIs against the same task in isolated git worktrees. Each agent gets its own workspace, a live tmux pane, refreshed read-only mirrors of rival workspaces, and a claim command. Runs can be manually judged or verifier-judged.

V1 includes built-in presets for:

- Claude Code: `claude`
- OpenAI Codex CLI: `codex`
- Cursor Agent CLI: `cursor-agent`

Custom shell commands are also supported.

## Install

```sh
npm install
npm run build
npm link
```

Agent Arena requires macOS or Linux plus `git` and `tmux`.

## Quick Start

From any directory:

```sh
arena
```

The setup TUI is a four-step wizard: Project, Teams & Agents, Task, Review & Start. Pick or create a git repo, edit teams in a one-row-per-agent table (Enter opens a per-agent editor for harness, model, thinking level, codename, instructions, and resources), then describe the task — either by chatting with a setup helper agent in its native CLI (it turns rambling into a structured goal, success criteria, constraints, resources, and per-agent instructions) or by filling in the form manually. Review the draft contract, send the helper feedback if needed, then approve and start.

TUI conventions throughout: `↑`/`↓` move within a screen, Enter activates or edits the selected row, `←`/`→` step between wizard screens, and Esc always goes one level back (input → list, sub-screen → parent, root → quit; quitting asks first when there are unsaved changes). `q` quits from any top level, `a`/`d` add and delete list items, every available key is shown in the footer bar, destructive actions ask for confirmation, the mouse works everywhere (click rows, buttons, and tabs; scroll lists with the wheel), and long text fields can open `$EDITOR`. Set `AGENT_ARENA_NO_MOUSE=1` to disable mouse handling.

When you approve, a launch-progress checklist replaces the console logs, and your terminal becomes the live **overseer** (see below); the agent CLIs run in a detached tmux session you can open on demand.

You can still write `arena.config.json` directly:

```json
{
  "baseRepo": ".",
  "baseRef": "HEAD",
  "goal": "Make the benchmark at least 3x faster without changing output correctness.",
  "successCriteria": [
    "Benchmark is at least 3x faster.",
    "Existing tests pass."
  ],
  "constraints": [
    "Do not change public APIs."
  ],
  "resources": [
    {
      "type": "env",
      "name": "OpenAI API key",
      "envVar": "OPENAI_API_KEY"
    }
  ],
  "judging": {
    "mode": "manual",
    "claimantBehavior": "wait",
    "notifyRivals": true
  },
  "competition": {
    "mode": "balanced",
    "rivalAwareness": "optional",
    "noticeIntervalSeconds": 180,
    "notifyOnClaim": true,
    "scoreboard": true
  },
  "agents": [
    {
      "id": "claude",
      "preset": "claude",
      "goalMode": "auto",
      "model": "sonnet",
      "thinkingLevel": "max",
      "instructions": "Keep changes small and explain proof before claiming.",
      "resources": []
    },
    {
      "id": "codex",
      "preset": "codex",
      "goalMode": "auto",
      "model": "gpt-5-codex",
      "thinkingLevel": "high",
      "instructions": "Use goal mode and keep iterating until ready to claim.",
      "resources": []
    }
  ],
  "peek": {
    "refreshIntervalSeconds": 30
  },
  "tmux": {
    "sessionPrefix": "agent-arena",
    "attach": true
  }
}
```

Start the match:

```sh
agent-arena start --config arena.config.json
```

In a terminal, `start` shows a launch-progress checklist and then opens the overseer TUI. Pass `--no-tui` (or `--no-attach`, or pipe the output) to get the plain console behavior that attaches tmux directly.

Agent Arena will:

1. Create one git worktree per agent under `.agent-arena/workspaces/<run-id>/`.
2. Write each agent a `.arena/goal.md`, `.arena/brief.md`, resource manifest, competition guide, scoreboard, rival summary, resource check script, and claim script.
3. Start a tmux session with one pane per agent.
4. Keep `.arena/rivals/<rival-id>/` refreshed from rival workspaces.
5. Record claims and decide winners according to the configured judging mode.

## Chat-First Setup

After agent selection, Agent Arena picks a setup helper:

1. Codex, if selected and installed.
2. Otherwise the first installed selected agent.
3. Otherwise the manual setup form.

The helper opens in a temporary tmux session using the agent's native CLI. It can inspect the project and ask questions, then writes:

```text
.agent-arena/setup-draft.json
.agent-arena/setup-secrets.env
.agent-arena/setup-complete.sh
.agent-arena/setup-auto-exit.sh
```

When the draft is ready, the helper is instructed to run `.agent-arena/setup-complete.sh` as its final completion/exit tool. That tool validates the draft JSON and closes the temporary helper tmux session, returning Agent Arena to the TUI review screen. Agent Arena also starts `.agent-arena/setup-auto-exit.sh`, which watches for a valid final draft and sends `/exit` before closing the helper session if the helper forgets to call the tool itself. If the helper changed project files outside allowed setup outputs, import is blocked and the TUI shows the changed files.

Raw secret values are stored only in `.agent-arena/secrets.env` or setup secret files. `arena.config.json`, goal files, status output, and review text show only env var names.

## Resources And Secrets

Resources are declared in `arena.config.json` as shared resources or per-agent resources. Env resources use env var names only:

```json
{
  "type": "env",
  "name": "Vast.ai API key",
  "envVar": "VASTAI_API_KEY",
  "usage": "Rent Vast.ai GPU instances for benchmark experiments that need CUDA.",
  "whenToUse": "Use when local compute is unavailable, insufficient, or too slow for the task.",
  "budget": "$50 per agent.",
  "cleanup": "Destroy rented instances when finished.",
  "verification": "Run a redacted auth or instance-list check without printing the key."
}
```

Absent `optional: true`, env and local file/path resources are required. A missing required env var or file path blocks `arena start`. Env values may come from the current process environment, per-agent env config, or `.agent-arena/secrets.env`; saved secrets are treated as available without printing their values.

Every agent workspace receives:

```text
.arena/resources.json
.arena/resource-orders.md
.arena/check-resources.sh
```

Agents are instructed to inspect the manifest, read the resource orders, and run the check before meaningful work. The claim script also runs the check before submitting a claim. Provider resources such as `gpu`, `cloud`, `ssh`, and `url` are recorded as declared/manual-check resources; Arena does not provision or validate provider accounts.

Resource orders make resources operational rather than passive prose. If local capabilities are insufficient and a declared resource provides the missing capability, the agent must use that resource or explicitly record why it is not needed. Review warns when a non-note resource lacks `usage` or `whenToUse`, because agents may otherwise ignore it.

## The Overseer

`arena overseer` (opened automatically after `arena start` in a terminal) is the human's live control room. It polls the run state, chat, and proposals every second and offers four views, switched with `1`-`4` or Tab:

1. **Dashboard** — every agent grouped by team with harness, model, state (`working` / `claimed!` / `winner` / `stopped`), changed-file counts, claims, and unread chat, plus a detail strip for the selected agent.
2. **Chat** — public, per-team, and per-agent DM threads with unread counts. You send messages as **Director**; recipients get an `ARENA CHAT` nudge in their panes.
3. **Proposals** — team patch proposals with per-file diff stats; apply one to the captain workspace with a confirmation.
4. **Judge** — pending finish claims with diff summaries. Accept (ends the run, with a hard confirmation), reject with a note (the agent is told to keep working), or ask for more (a Director DM; the claim stays pending).

Global keys: `o` opens the agent tmux session in an external terminal, `p` sends a pressure notice, `r` forces a refresh, `R` restarts a dead mirror daemon, `q` quits the overseer while the run continues. Esc follows the same back-one-level rule as the wizard: it returns to the Dashboard from any other view and quits from the Dashboard. If multiple runs are running, a picker appears; finished runs open read-only.

## Competition Director

Agent Arena adds lightweight competitive pressure without forcing agents to constantly inspect rivals. This is built in and not configurable. Each workspace receives:

```text
.arena/competition.md
.arena/scoreboard.md
.arena/rival-summary.md
```

The mirror daemon updates these files while refreshing rival mirrors, and sends an occasional tmux pressure notice (every ~3 minutes). Claim notices are stronger and include the claimant, pending status, mirror path, and top changed files.

Rival mirror use is optional by default. Agents are told to inspect rivals only when it naturally helps: when stuck, after a rival claim, before final claim, or to compare approaches. They are also told not to spend time on rivals when their current path is clearly productive.

## Teams, Chat, And Proposals

Agent Arena can run teams instead of only individual agents. Old configs without `teams` still work; each agent becomes its own one-agent team. New configs can put multiple agents on a team, including duplicate harness presets with unique agent ids:

```json
{
  "teams": [
    {
      "id": "red",
      "name": "Team Red",
      "captainAgentId": "red-codex",
      "agentIds": ["red-codex", "red-claude"],
      "instructions": "Split research and implementation, then integrate through the captain.",
      "resources": []
    },
    {
      "id": "blue",
      "name": "Team Blue",
      "captainAgentId": "blue-cursor",
      "agentIds": ["blue-cursor"]
    }
  ],
  "agents": [
    { "id": "red-codex", "preset": "codex" },
    { "id": "red-claude", "preset": "claude" },
    { "id": "blue-cursor", "preset": "cursor" }
  ]
}
```

Each agent gets a stable codename. You can set one with `codename`, or Arena assigns unique deterministic names at run start.

V1 uses a captain claim model. Only the team captain can submit the final claim from the captain workspace. Non-captain agents should coordinate through chat or propose patches:

```sh
./.arena/chat.sh team "message to teammates"
./.arena/chat.sh public "message to all teams"
./.arena/chat.sh dm <agent-id> "direct message"
./.arena/chat.sh inbox
./.arena/chat.sh history
./.arena/propose-patch.sh "title" "summary"
./.arena/apply-proposal.sh <proposal-id>
```

Team, public, DM, inbox, and proposal markdown files are rendered under `.arena/chat/` and `.arena/proposals/` in every workspace. Chat is backed by run-level JSONL storage, so unread inbox state persists. New messages send a short tmux nudge such as `ARENA CHAT: You have a pending team message from Nova`; message previews are not included in nudges.

The human participates as **Director** under the reserved sender id `user` — from the overseer's Chat view or with `arena chat send --agent user` (team messages need `--team <id>`). Agents can DM the Director back with `./.arena/chat.sh dm user "message"`. The agent id `user` is therefore not allowed in configs.

Patch proposals capture a non-captain's current git diff into the run directory. The captain can apply a proposal with `git apply --3way` through the helper script. Arena records apply success or failure, but it does not auto-commit and does not auto-resolve conflicts.

## Goal Mode

Built-in presets support:

```json
{ "id": "codex", "preset": "codex", "goalMode": "auto" }
```

`goalMode` can be:

- `auto`: use `/goal` when the installed CLI supports it; otherwise warn and use prompt mode.
- `goal`: require `/goal` and fail startup if the preset or installed CLI cannot support it.
- `prompt`: skip `/goal` and launch with a goal-like prompt.

Agent Arena writes the full task contract to `.arena/goal.md` and keeps the launch prompt short enough for CLI goal limits. Codex uses:

```sh
codex -c features.goals=true "/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly."
```

Claude Code uses the same `/goal` contract when `claude --version` is `2.1.139` or newer. Claude Code `2.1.98`, for example, is too old and falls back in `auto` mode. Codex `0.133.0` and newer is treated as goal-capable. Cursor Agent CLI does not currently document `/goal`, so the Cursor preset uses prompt mode.

If a CLI's version cannot be read or parsed at all (for example a dev build with nonstandard `--version` output), `auto` mode falls back to prompt mode with an explicit launch note, and `agents doctor` prints a warning. Set `goalMode: "goal"` to force `/goal` when you know the installed CLI supports it.

## Model And Thinking Settings

Built-in agents can also set harness-level model and thinking settings:

```json
{
  "id": "codex",
  "preset": "codex",
  "goalMode": "auto",
  "model": "gpt-5-codex",
  "thinkingLevel": "high"
}
```

`thinkingLevel` accepts `auto`, `low`, `medium`, `high`, `max`, or `xhigh`. `auto` keeps the CLI default.

Agent Arena passes these settings as CLI flags where supported:

- Claude Code: `--model <model>` and `--effort <low|medium|high|max>`. `xhigh` maps to `max`.
- Codex CLI: `--model <model>` and `-c reasoning_effort="<low|medium|high|xhigh>"`. `max` maps to `xhigh`.
- Cursor Agent CLI: `--model <model>`. Thinking level is recorded in `.arena/goal.md` until Cursor exposes a documented thinking flag.

## Claiming A Win

Each workspace gets:

```sh
./.arena/claim.sh
```

In manual judging mode, agents should run that command when they believe their work is ready. The claim is recorded as pending, rival panes receive a competitive notice, and the claiming agent waits for user judgment. Judge from the overseer's Judge view, or from the CLI:

```sh
arena judge accept --run <run-id> --agent <agent-id>
arena judge reject --run <run-id> --agent <agent-id> --note "why"
```

Rejecting notifies the agent in its pane and the match continues.

In verifier judging mode, the claim command snapshots the claiming agent's workspace and runs the verifier in a clean, detached checkout of that snapshot (the temporary checkout is removed afterwards). If it exits `0`, that agent wins. If it fails, the claim is logged and the match continues. Old configs with top-level `verifyCommand` are still supported.

To stop agents from winning by editing the tests, list verifier-owned paths in `judging.protectedPaths`. Those paths are restored from `baseRef` in the verification checkout before the verifier runs (protected paths added by the agent are removed):

```json
{
  "judging": {
    "mode": "verifier",
    "verifyCommand": "npm test",
    "protectedPaths": ["tests/", "package.json"]
  }
}
```

Keep the verifier's tests under a protected path so agents can only win by changing the implementation.

## After The Run

When a claim is accepted (or a verifier claim passes), the winner's work lives in its arena branch and workspace, not in your repo. Harvest it:

```sh
arena harvest --run <run-id>            # commit winner's work to its branch, merge into your checked-out branch
arena harvest --run <run-id> --no-merge # only commit to the winner's branch; merge manually later
```

Harvest commits any uncommitted winner work to the agent branch (excluding `.arena/` runtime files and likely secrets), then merges that branch into the currently checked-out branch of the base repo with `--no-ff`. It refuses if the base repo has uncommitted tracked changes, and aborts cleanly on merge conflicts so you can merge manually. The overseer also offers this right after you accept a claim.

Then inspect and clean up:

```sh
arena runs list                          # all local runs with status, winner, and harvest state
arena stop --run <run-id>                # kill the run's tmux session and mirror daemon; status becomes "stopped"
arena clean --run <run-id>               # remove worktrees, workspaces, and the run dir (refuses running runs; --force stops first)
arena clean --finished                   # clean every non-running run
arena clean --run <run-id> --branches    # also delete agent branches (an unharvested winner branch is kept)
```

## Commands

```sh
agent-arena init
arena
agent-arena agents list
agent-arena agents doctor --config arena.config.json
agent-arena start --config arena.config.json [--no-tui]
arena overseer [--run <run-id>] [--state <path>]
agent-arena status --run <run-id>
agent-arena claim --run <run-id> --agent <agent-id>
arena harvest --run <run-id> [--no-merge]
arena runs list
arena stop --run <run-id>
arena clean [--run <run-id> | --finished] [--force] [--branches]
arena pressure --run <run-id> [--agent <id>] [--message "..."]
arena judge accept --run <run-id> --agent <agent-id>
arena judge reject --run <run-id> --agent <agent-id> [--note "..."]
arena chat send --run <run-id> --agent <agent-id> --scope team|public|dm --message "..."
arena chat send --run <run-id> --agent user --scope team --team <team-id> --message "..."
arena chat history --run <run-id> [--team <id>|--public|--agent <id>]
arena chat inbox --run <run-id> --agent <agent-id>
arena proposal create --run <run-id> --agent <agent-id> --title "..." --summary "..."
arena proposal apply --run <run-id> --agent <captain-id> --proposal <proposal-id>
arena proposal history --run <run-id> [--team <id>]
```

`status` and `claim` can also take `--state /path/to/state.json` if the run is not in the global run index.

## Command Templates

Agent commands can use these placeholders:

- `{goal}`
- `{goalFile}`
- `{claimCommand}`
- `{rivalDir}`
- `{workspace}`
- `{agentId}`
- `{runId}`
- `{model}`
- `{thinkingLevel}`
- `{goalDirective}`
- `{promptDirective}`
- `{teamId}`
- `{teamName}`
- `{agentCodename}`
- `{captainAgentId}`
- `{chatCommand}`

Placeholders are shell-escaped automatically, so do not wrap them in extra quotes:

```json
{
  "id": "custom",
  "command": "my-agent --prompt {goal} --cwd {workspace}"
}
```

## Rival Mirrors

Agents do not receive writable access to the rival workspace. Instead, Agent Arena syncs the rival workspace into:

```text
.arena/rivals/<rival-id>/
```

The mirror is chmod'd read-only after each sync and excludes `.git`, `.agent-arena`, `.arena`, dependency folders, caches, and common secret files. Agents may use these mirrors as optional tactical context, but the default prompt tells them not to poll rivals if that would waste time.

This is an accident-prevention boundary, not a hostile security sandbox. Processes running as the same OS user can usually change permissions back.

Set `competition.rivalAwareness` to `"off"` (also reachable from the wizard's Task screen) to disable rival visibility entirely: no `.arena/rivals/` directories are created, no mirror syncing happens, and agent briefs tell each agent to focus only on its own work. Scoreboard and competition files still update.

## Examples

Example configs live in `examples/`:

- `claude-vs-codex.json`
- `claude-vs-cursor.json`
- `codex-vs-cursor.json`
- `claude-vs-codex-vs-cursor.json`

## Notes

- Existing projects must be git repos; the TUI can create a new empty git repo for you.
- Worktrees are created from `baseRef`; uncommitted changes in the source checkout are not copied.
- V1 targets macOS and Linux only.
- Other agent CLIs are deferred, but custom commands work now.
