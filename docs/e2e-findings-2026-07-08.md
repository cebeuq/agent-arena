# E2E Test Run Findings — 2026-07-08

Full product walkthrough: setup wizard driven keystroke-by-keystroke over tmux,
2v2 race (Claude Opus 4.8 + Codex gpt-5.5 per team, opposite-harness captains)
on the `mlp-speed-arena` demo repo, manual judging, harvest, and lifecycle
cleanup. Run id: `20260708T052502Z-9fe6e000`.

## Outcome

The whole pipeline worked end to end with no blocking bugs:

- Wizard: all 4 screens, agent editor (harness/model/custom model/captain/team
  move), rival awareness field cycled through all 3 values, contract preview
  accurate, start confirm dialog fired (the `useLayoutEffect` fix holds).
- Launch: preflight probed both real models, 4 worktrees, trust warmup opened
  in an external window, briefs/mirrors/tmux/daemon all green.
- Race: all 4 agents worked immediately; chat (public, DM, team), pressure
  notice, and read-only rival mirrors all verified live; agents used
  `chat.sh` to coordinate on their own.
- Judging: Remy (blue captain, gpt-5.5) claimed at ~5.5 min with a legitimate
  11x speedup (2988ms → 269ms, tests green, referee files untouched). Accept
  flow ended the run, interrupted rivals, and offered the new harvest prompt.
- Harvest: merged into `main` (merge commit `d658cee`), no `.arena`/`.agent-arena`
  junk tracked, tests + benchmark pass in the base repo.
- Lifecycle: `status` showed winner + harvest; final-report.md had the Harvest
  section; `runs list` showed `(harvested)`; `clean --branches` removed all 4
  workspaces and branches (winner branch correctly deleted only because it was
  harvested; the pre-flight cleanup of June runs correctly *kept* unharvested
  winner branches).

## Bugs found (none blocking)

1. **Changed-file names truncated in overseer/judge view.**
   Judge view showed `Changed files: 1 — iny_mlp/model.py` (missing `t`).
   Cause: `workspaceGitOutput*` in `src/competition.ts` does
   `result.stdout.trim()`, which eats the leading space of the first
   `git status --short` line (` M path`); `cleanStatusPath` then slices 3
   chars off what is now a 2-char prefix. Also risks mis-filtering an
   `.arena` path if it lands on the first line. Fix: trim only trailing
   whitespace / split before trimming.

2. **Accepting a claim leaves the same agent's duplicate claim pending.**
   Remy claimed twice (05:30:38 and 05:31:13). After accepting the first,
   the run is finished but Judge still shows "Pending claims (1)" and the tab
   badge shows `4 Judge (1!)`. `arena status` also lists a pending claim on a
   finished run. Accepting should resolve/supersede other pending claims (at
   least from the same agent).

3. **Winner elapsed rendered as raw milliseconds.**
   `arena status` prints `Winner: red-codex-3 (446429ms)` — should be `7m 26s`.

4. **`clean` leaves the run's tmux session alive.**
   After cleaning the finished run, session `agent-arena-9fe6e000` (team
   sidebar panes + interrupted agent panes) survived while its workspaces were
   deleted underneath it. `cleanRuns` should kill the session for finished
   runs too (it only does via `stopRun --force` for running runs).

5. **Daemon badge says `daemon: DEAD (R restarts)` on a finished run.**
   The mirror daemon legitimately exits when the run finishes; showing DEAD
   in red with a restart hint is misleading. Should render as `stopped` when
   status != running.

## UX rough edges (follow-up candidates)

6. **Agent ids don't follow harness/team changes.** Adding an agent to Team
   Red then switching harness to Claude keeps id `red-codex-2`; moving an
   agent to Team Blue keeps `red-codex-3`. The race then shows "red-codex-3 —
   Team Blue" everywhere (status, judge view, branches). Consider re-deriving
   the id (or offering to) when preset/team change before start.

7. **Custom model prompt pre-fills the current id with cursor at end.**
   Entering a custom model after a picker selection requires manually erasing
   the old id first ("gpt-5-codexgpt-5.5" if you just type). Pre-select the
   text or start empty with the old value as placeholder.

8. **Rapid key bursts get coalesced/dropped.** Three arrow-key presses sent in
   one stdin chunk moved the SelectList by one item; fast backspaces dropped
   too. Human typing is fine, but paste-heavy input or automation trips it.
   Consider iterating over all key events in a stdin chunk instead of one
   dispatch per chunk.

9. **Teammates appear under `.arena/rivals/`.** Dara's rivals dir contains
   red-codex-2 (own teammate) alongside the two blue agents. Functionally
   handy but confusing naming; either exclude teammates or rename the dir
   (e.g. `mirrors/`).

10. **Danger confirms default to Cancel with no visual affordance captured in
    hints.** "Accept & finish" needed Left+Enter; the first Enter silently
    cancelled with no toast. Deliberate safety choice, but a "cancelled" toast
    (or focusing Cancel with a clearly highlighted border) would avoid the
    "did my accept do anything?" moment.

## Notes

- Both model ids (`opus`, `gpt-5.5`) verified live in preflight.
- Baseline benchmark on this machine: median_ms=2988 (batch 512); harvested
  main now runs at ~175ms.
- Demo repo kept at `~/arena-testbeds/mlp-speed-arena` (merge commit on main,
  `.agent-arena/` and `arena.config.json` untracked).
