# QA fix plan — 2026-07-09

Companion to `docs/qa-findings-2026-07-09.md`. Findings are grouped into four tiers; fix in tier order. Each item names the file(s) and the intended change. Re-verify every fix by repeating the same drive that surfaced it (rebuild → launch → exercise the exact screen), and add vitest coverage where noted.

## Tier 1 — correctness (do first; root causes verified)

1. **Eaten first filename char** — `src/competition.ts:115`. `workspaceGitOutputAsync` returns `result.stdout.trim()`; the whole-blob trim strips the leading space of the first `git status --short` line (` M path`), so `cleanStatusPath`'s `slice(3)` eats a real char.
   - Change: `return result.stdout;` (drop `.trim()`). `parseAgentProgress` already does per-line `trimEnd()` + `filter(Boolean)`.
   - Test: add a case to `tests/competition.*` with a status blob whose first line starts with a space; assert `changedFiles[0]` is intact.

2. **Harvest-merge fails on a base dirtied by arena itself.**
   - `src/tui/index.tsx:67` writes `arena.config.json` on every start. Only write when the serialized config actually differs from what's on disk (compare before writing), so a clean repo stays clean.
   - `src/harvest.ts:92` guard is correct; keep it. But surface failure in the UI: in `src/tui/overseer/judge-view.tsx:40` (`offerHarvest`) the error is only a 2.5s toast (`useToast.ts:4`). Reflect a `harvest-failed` state + reason in the durable WINNER banner (`src/tui/overseer/overseer-app.tsx:364`) and add an inline retry key (e.g. `h`).

3. **Harvest state not reconciled across merge vs `--no-merge`.** A branch-only harvest leaves `state.harvest` unset, so `clean --branches` keeps the branch and `runs list` still says "(harvested)". Write a consistent `harvest` record (branch, merged: bool, targetBranch?) in both `harvest.ts` paths and have `clean`/`runs list` read it.

## Tier 2 — interaction & flow

- **Setup-helper failure path** (`src/tui/index.tsx` helper branch + `src/setup.ts`): don't offer "Send feedback"/"Rerun helper" when no helper session exists (or make them start one explicitly); on helper exit-without-draft, abort the wait with a clear message instead of hanging at "Waiting for helper output…"; resume at Review (where it was launched), not Task; replace the raw `ENOENT` toast with a plain-language message.
- **Chat input swallows number keys** (`src/tui/overseer/chat-view.tsx`): blur the input after send, or route number keys to view-switch when the input is empty.
- **Confirm default focus** (`src/tui/components/ConfirmDialog.tsx` + callers): one rule for irreversible actions (recommend affirmative-focus only on the winner-harvest happy path, Cancel elsewhere); toast on cancel so the dismissal is visible.
- **Pending claims persist after finish** (`judge-view.tsx` / `overseer-app.tsx` banner): mark non-accepted claims terminal and drop the yellow banner + `(N!)` badge when the run is finished.
- **Daemon DEAD badge + dead `R` on finished runs** (`overseer-app.tsx`): suppress the badge and the `R` hint when `status==="finished"`.
- **Add-agent selection** (`src/tui/screens/TeamsScreen.tsx`): after `a`, select the newly created agent row (mirror the add-team behavior).
- **Mouse press+release coalescing** (`src/tui/mouse/parse.ts` + `MouseProvider.tsx:63`): scan each stdin chunk for all SGR sequences instead of anchoring the regex to the whole chunk.
- **Review PgUp/PgDn eaten by the Actions list** (`ReviewScreen.tsx` + `SelectList.tsx`): give the contract-scroll handler priority, or move focus into the contract panel.
- **`clean` leaves a finished run's tmux session** (`src/lifecycle.ts`): kill the session in `clean` (or print a warning + the `stop` command).
- **Invalid project path discards input** (`ProjectScreen.tsx` + prompt): keep the prompt open with an inline error; report a nonexistent path as "does not exist", not "not inside a git repository".
- **Custom-command harness in the wizard** (`AgentEditorScreen.tsx` harness picker): add a "custom command" option so wizard configs can express what `arena start --config` already supports.

## Tier 3 — layout & alignment

- **Harness column truncation** (`TeamsScreen.tsx`, `overseer/dashboard.tsx`): make column widths responsive to terminal width instead of a fixed truncate.
- **80×24 detail panel dropped** (`dashboard.tsx` body `rows-16`): give the detail panel a min height or a collapsed single-line fallback; stop hard-truncating the file-count column.
- **Resource form empty states** (`ResourceFormScreen.tsx`): one convention (dim placeholder vs "not set"); don't render "required" errors before first interaction.
- **Step N/4 on sub-screens** (`AppShell.tsx` / route titles): keep the step indicator on agent editor / resource screens.
- **Footer keybar stale under modals** (`KeyBar.tsx` / modal layer): show the active layer's keys.
- **Task Goal wrapped-value misalignment** (`TaskScreen.tsx`): align continuation lines to the field-value column.
- **Tall-screen dead zone** (`AppShell.tsx`): distribute vertical space or cap the shell to content height.
- **Review contract wraps vs truncates** (`ReviewScreen.tsx`): wrap long lines rather than `…`-truncating the goal.

## Tier 4 — copy

- "Draft contract — contract" → drop the duplicate mode word; capitalize "JSON".
- Codename fallback prints twice ("id (id, harness)") → show codename once, or the id once.
- Pluralization: "N checkpoint(s)/warning(s)" → real singular/plural.
- New team "Team 3" beside "Team Red/Blue" → continue the color scheme; toast should use the display name.
- `final-report.md`: add human-readable winner elapsed (`src/report.ts`); suppress empty verifier stdout/stderr for manual claims.
- Warnings: surface in the Actions panel, not only inside the (broken-scroll) contract.
- Dirty-quit: only warn when the draft actually changed.
- Resource blurb "ordered to check" → "instructed to check".
- Review section ordering: make "Teams" and "Harness settings" agree.
- `arena agents list`: hide or reword "goal command: not documented" for cursor.

## Verification checklist

- `npm run build && npm test` green (incl. new competition/harvest tests).
- Fresh wizard drive (tui-create-smoke) re-checks Tier 3/4 wizard items.
- One live match (real or a custom-command fake) re-checks Tier 1/2 overseer items end-to-end through harvest.
- Teardown with `arena stop` + `arena clean`, and restore any config the run rewrote.
