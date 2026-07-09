# QA findings — human-style TUI pass, 2026-07-09

Method: drove the built TUI (`npm run build`, global `arena` link) inside a dedicated tmux session at 120x40 (plus an 80x24 pass), sending real keystrokes, SGR mouse clicks/wheel, and $EDITOR round-trips; captured every screen with `tmux capture-pane`. Raw captures: session scratchpad `captures/` (numbered, referenced below as `#NNN`).

Status: **complete** — wizard pass + a full real-CLI live run (teamflow-taskforge, 3 teams / 4 agents: codex + claude, ~8.5 min, real claims/proposals/judging/harvest).

## Highest-severity (live run)

L1. **In-TUI "Harvest & merge" failure is only a 2.5s transient toast; the persistent state gives no failure context** (#090–#092). Accepting the winner offered a Harvest confirm; "Harvest & merge" left nothing committed, `harvest: null` in `state.json`, winner branch == base HEAD, and the banner still reading "not harvested; run: arena harvest…". `runAction`'s catch *does* `showToast(error.message,"error")` (`overseer-app.tsx:132`) — but `TOAST_DURATION_MS=2500` (`useToast.ts:4`), and after the busy spinner the error is easy to miss; the durable WINNER banner never reflects that a harvest was attempted-and-failed or why. The swallowed reason (CLI shows it): `Base repo … has uncommitted changes… run harvest with --no-merge`. Fix: reflect harvest-failed + reason in the durable banner, and/or persist the last action error until dismissed, and offer an inline retry (e.g. `h`). `src/tui/overseer/judge-view.tsx:40` (offerHarvest) + `overseer-app.tsx:364` (banner) + `src/harvest.ts:92`.

L2. **`arena start` dirties the base repo by rewriting `arena.config.json`** (57+/42− reformat on this run), which is exactly what then blocks L1's harvest-merge. Arena creates the dirty state that defeats its own harvest. Either don't rewrite the committed config on start, write it atomically only when changed, or exclude it from the harvest dirty-check. `src/tui/index.tsx:67` (config write) + `src/harvest.ts` (dirty guard).

L3. **First character of every changed filename is eaten** across all overseer surfaces (prior issue #1, still open): dashboard detail "5 changed file(s): **ackage.json**, src/cli.js…" (#096), judge claim detail "**rc/planner.js**" (#082/087), Kai "rc/planner.js". Off-by-one/`.trim()` on `workspaceGitOutput*` in `src/competition.ts`. High-visibility, misleads the judge about what changed.

## Bugs

1. **Mouse clicks dropped when press+release arrive in one stdin chunk.** `parseMouseInput` anchors its regex to the whole chunk (`src/tui/mouse/parse.ts:9`), and `MouseProvider`'s stdin listener parses each data event as a single sequence (`src/tui/mouse/MouseProvider.tsx:63`). A fast click whose `\e[<0;x;yM\e[<0;x;ym` batches into one read is silently ignored (verified by injection; split press/release works). Also means any mouse event batched with other input is lost. Fix: scan/split the chunk for all SGR sequences.

2. **PgUp/PgDn never scroll the Review contract panel despite the footer advertising it** (#056/057). The Actions `SelectList` (priority `list`=25) consumes PgUp/PgDn before the screen-level scroll handler (priority `screen`=20) — selection jumps to first/last action instead, and the contract line-range header stays fixed. Wheel scrolling works. `src/tui/screens/ReviewScreen.tsx` + `src/tui/components/SelectList.tsx:139`.

3. **After `a` (add agent) → editor → Esc, list selection sits on the first agent, not the new one** (#031/032). I pressed `d` expecting to remove the just-added `red-codex-2` and the dialog targeted `red-codex` — deleted my fully customized agent. Selection should follow the newly created row (compare: `t` add-team does follow the new team, #033).

4. **Confirm dialogs pre-focus Cancel but hint says "Enter confirm"** (#024, prior-pass issue #10 still present). Enter with Cancel focused silently dismisses — no "cancelled" feedback (#025) — so a user believes they deleted/accepted. Either focus the affirmative button on non-destructive confirms, or change the hint to "Enter = focused button", and toast on cancel.

5. **Setup-helper failure path strands the user** (#048–#052):
   - "Send feedback to helper…" / "Rerun helper" are offered even when no helper session ever ran; submitting feedback silently launches a brand-new helper (Codex trust prompt and all).
   - If the helper CLI exits without writing a draft (e.g. declining the trust prompt), the setup tmux session sits at "Waiting for helper output…" forever with no abort hint; the suspended wizard pane shows raw shell scrollback (looks crashed). Recovery required killing the tmux session by hand.
   - After recovery the wizard resumes at **Task**, not Review where feedback was initiated, and the toast leaks a raw truncated Node error: `Setup helper did not produce a valid draft: ENOENT: no such file or directory, open` (#052).

6. **Invalid project path: prompt closes and discards input** (#004/005). Entering a bad path shows the toast then throws away everything typed; reopening starts blank. Keep the prompt open with an inline error. Copy nit: nonexistent path reports "That path is not inside a git repository" — "does not exist" would be accurate.

## Layout / alignment

7. **Teams table harness column is fixed-width and truncates "OpenAI Codex CLI" → "OpenAI Codex…"** even at 120 cols with ~90 unused columns (#008). Adjacent model column makes it read "OpenAI Codex… CLI default". Widths don't respond to terminal width (identical truncation at 80 cols, #054). `src/tui/screens/TeamsScreen.tsx`.

8. **Step indicator (Step N/4) disappears on sub-screens** (agent editor #009, resource list #016) — title-bar right side goes empty; users lose wizard context.

9. **Footer keybar goes stale under modals** (#003): while a text prompt owns input, the footer still shows the underlying screen's `↑↓ Move · Enter Select · Esc Quit`.

10. **Resource form mixes three empty-state styles** (#018): blank (Name), placeholder-that-looks-like-a-value (`MY_API_KEY`, "What should agents do with it?"), and literal "not set" (Description/Budget/…). Validation errors ("Name is required.") render before the user has touched the form.

11. **Tall screens leave a large dead zone** — panels are content-height while the shell pads to full terminal height (Project #001: 24 blank rows between panels and footer at 40 rows). Mockups (`design-concepts/tui-revamp/simple-pack/`) show fuller vertical usage.

12. **Project info path value wraps mid-word** at narrow widths ("…klausclawd/a / rena-testbeds…", #053).

13. **Review contract truncates lines with `…` rather than wrapping** at 80 cols (#055), including the goal text.

## Consistency / keys

14. **Esc semantics differ between inline fields and modal prompts.** Inline Goal edit: typed text is kept on Esc (#036). Modal prompts: Esc discards. One of them surprises the user; pick one rule (Esc=cancel) or show "Esc keeps changes" hint inline.

15. **Home/End work in SelectList screens but not in the resource form's field list** (#019: End was a no-op; Home worked on Teams #033).

16. **Wizard offers only the 3 presets — no custom-command harness** — though the engine and `arena start --config` fully support `command` agents (README "Custom shell commands are also supported"). Wizard-built configs can't express them.

## Copy

17. Review header: "**Draft contract — contract**" (mode suffix duplicates the word); JSON mode shows lowercase "json" (#041/#042).
18. Team lines print "**red-codex-2 (red-codex-2, codex)**" — codename falls back to id and prints twice (#041).
19. "2 checkpoint(s)", "1 warning(s)" — lazy pluralization (#039, #055).
20. New team is named "Team 3" beside "Team Red/Blue" (color scheme not continued), toast says "Added team-3 with one codex agent." using the id (#033).
21. Resource list blurb: "Agents are **ordered** to check them before working" — reads as sort-order; "instructed" (#016).
22. `arena agents list` (console): cursor preset prints "goal command: **not documented**" alongside concrete commands for other presets.
23. Warnings live only inside the scrollable contract; the Actions panel says "1 warning(s) — see contract." making the user hunt (#055) — and contract PgUp/PgDn scrolling is broken (finding 2).
24. Quit dialog claims "Your draft has unsaved changes" after zero edits (dirty flag set by navigation/project selection alone, #058).
25. Review "Harness settings" section lists agents alphabetically (blue before red) while "Teams" lists red first (#041).

## Verified good

- Click-to-activate on lists, wheel scrolling (3 lines/notch), clickable footer chips, ConfirmDialog y/n and ←/→+Enter, Home on SelectList, $EDITOR round-trip restores the alt screen and repaints cleanly (#015), codename/instructions truncation with ellipsis in editor rows, judging toggle updates dependent Verifier field (required marker + placeholder), done-when ListEditor add/edit flows, AGENT_ARENA_NO_MOUSE=1 fully inert clicks, quit-confirm gating, invalid-path toast (modulo 6), fresh-draft isolation between wizard sessions, 80x24 fits incl. 70-col modals, stale-run cleanup via `arena stop`/`clean --finished`.

## Prior-pass issues (docs/e2e-findings-2026-07-08.md) re-checked so far

- #7 custom-model prompt prefill: **improved/OK now** — prompt opens empty when model is CLI default (#012); (prefill-on-existing-value still to re-check).
- #10 danger-confirm default: **still present** (finding 4).
- #6 agent ids not following team/harness: partially reproduced — deleting `red-codex` leaves a team whose only agent is `red-codex-2` (dangling suffix); ids never renormalize.
- #1 truncated filenames: **CONFIRMED still open** (L3 above).
- #4 `clean` leaves finished run's tmux session alive: **CONFIRMED** — after accept+quit, `agent-arena-5139b390` (3 windows) and the `-view-blue-codex` session I opened were still running; only `arena stop` kills them.
- #5 daemon `DEAD (R restarts)` badge on a finished run: **CONFIRMED** (#091/093) — badge shows on a legitimately finished run and the "(R restarts)" hint is misleading; pressing `R` does nothing there.
- #3 raw ms: winner `elapsedMs: 511245` in state.json; the final report omits elapsed entirely (no human-readable duration anywhere in `final-report.md`) — arguably worse than raw ms. `src/report.ts`.
- #2 duplicate/pending claims after accept: after accepting red-codex, Judge tab still shows **(2!)** with Kai + Iris "pending", and the yellow "press 4 to judge" banner persists on a finished, read-only run (#090/097). Pending claims should clear/mark-terminal when the run ends.

## Live-run additional findings

L4. **Overseer keys swallowed while the chat input holds focus.** After sending a Director message, `3`/`4`/`1` typed into the still-focused input field ("34" ended up in the box, #074/075) instead of switching views; the footer had already reverted to "1-4 Views". Need Esc to release focus first — but nothing signals that. Either blur the input after send or let number keys switch views from an empty input.

L5. **Confirm-dialog default focus is inconsistent across destructive actions.** Remove-resource/agent/team and Accept-claim pre-focus **Cancel** (safe), but the post-accept **Harvest** dialog pre-focuses **Harvest & merge** (affirmative) — #089 vs #090. Pick one rule for irreversible actions.

L6. **`runs list` labels the run "(harvested)" after a `--no-merge` harvest** that only committed to the branch and explicitly did not merge (#, CLI). The winner banner is more precise ("harvested to branch … (not merged)"). Align the two.

L7. **Empty verifier output renders as bare "(empty)"** for both stdout and stderr in `final-report.md` on a manual claim — expected (no verifier), but reads like something failed. Suppress the section for manual judging.

L8. **80x24 overseer drops the detail panel entirely** (#097): the bottom Nova branch/workspace/claim panel is clamped out (`dashboard.tsx` body `rows-16`), and the table still hard-truncates "OpenAI Codex…" and "fil…" (files count). No horizontal responsiveness.

## Verified good (live run)

- Real 4-agent codex+claude run launched, raced, and finished end-to-end. Trust warmup session (`-trust`, 4 tiled panes), per-team windows, mirror daemon, and live 1s polling all worked.
- Chat: Director send to a team thread delivered and displayed; unread badges incremented per thread and on the Chat tab; opening a thread cleared its unread.
- Proposals: a real teammate patch (Ada → captain) surfaced within ~3 min with correct title/from/status, and detail view showed accurate per-file +/− stats and patch path.
- Judge: pending-claim list, `x` reject-with-note, `m` ask-for-more (DM sent, claim stays pending), and `a` accept→end all worked; accept interrupted rival panes and wrote `final-report.md`.
- Read-only enforcement after finish: chat input shows "Run finished — chat is read-only history."; mutating actions disabled with a one-time toast.
- `o` opened the selected agent's pane as an in-session tmux split (grouped `-view-` session); `q` left the run alive by design.
- Harvest `--no-merge` (CLI) correctly committed the winner's uncommitted workspace to its arena branch.
- Loading an existing multi-team config into the wizard rendered codenames, captains, thinking levels, aggregated resource counts, and "instructions set" markers correctly; helper→Review round-trip preserved the full draft.

## Teardown

Stopped + cleaned run `20260709T203426Z-5139b390`; restored `teamflow-taskforge/arena.config.json` (arena's start-time rewrite); killed leftover `agent-arena-5139b390*` sessions and the `arena-qa` session. `knn-speed-arena` stale runs cleaned at the start of the pass.
