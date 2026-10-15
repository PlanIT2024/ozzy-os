# bIT OS Phase 2c dashboard

Implemented on `phase2c-dashboard` in `/home/ozzy/ozzy-os-2c`. Changes are confined to `apps/dashboard/` and this report. No backend, migration, environment, or live checkout changes.

## What changed

The task panel now requests runs through the existing signed-in Supabase client and publishable key. Inserts match `scripts/bitos-cli.mjs`: client UUID, task ID, node ID, executor, folder alias, prompt, lease minutes, `status: requested`, and `requested_by` equal to the signed-in user. No execution API or privileged client is introduced.

Machine options require `run_agent`, online status and a heartbeat no older than three minutes. Executors and folder aliases come from `nodes.metadata.agent`; lease options are 20/40/60 minutes filtered to the advertised maximum. If no standard lease fits, that machine is unavailable. Missing configuration, disabled capabilities and offline/stale machines receive explanations. The prompt starts with the task title and description and has an 8000-character limit and counter.

Approvals join their run details in the client. Only the node owner sees Approve/Deny. Decisions update only `status` and `decided_by`; the existing trigger stamps `decided_at`. Expired or invalid expiry values have no decision controls. Command approvals require a second click within five seconds; run approvals and writes require one. Both controls disable while sending, including a synchronous guard against duplicate clicks. Supabase errors appear as plain text. The tab title counts unexpired pending approvals; on screens under 640px, pending approvals move above the overview.

Workspace data now includes runs and listens for run changes. Board cards show running and approval indicators. The task panel shows newest runs first with status, executor, machine, lease, branch and finished summary. Owner Stop controls update only `stop_requested: true` and display “Stopping…” while the run remains active. The task event log loads the task's complete visible event history, oldest first, and reloads through a task-filtered Realtime subscription. It follows new events until the user scrolls up and resumes following near the bottom.

Workspace subscriptions clean up on workspace/user changes. Closing the task panel, changing workspace or signing out unmounts the task log and removes its subscription. Late query results are ignored. All database text uses React text rendering, with no generated links or HTML interpretation.

## Screenshots in words

- **Task panel / Run on a machine:** below the task editor, stacked Machine, Executor, Folder alias and Lease selects, followed by the prefilled prompt, character counter and Run button. With no eligible machine, explanatory text replaces the form.
- **Approvals:** bordered cards show executor and machine. Run cards include folder, lease and a prompt preview. Agent cards show a readable write/action or a monospace command. A seconds countdown sits above Approve/Deny; non-owners see “Waiting for MACBOOK owner”; expired cards say “Expired”. The command button changes to “Approve command?” after its first click.
- **Task panel / Runs:** bordered entries show a status pill and execution details. Finished summaries appear as literal text. Active owner entries have Stop, changing to disabled “Stopping…” after the database confirms the request.
- **Task panel / Live log:** a bounded scrolling area shows time, event kind and summary, with new events at the bottom. Scrolling upward preserves the reading position.
- **Board and mobile:** task cards carry a green running indicator and a numbered pending approval badge. A narrow viewport puts pending approvals first; the browser tab reads, for example, “(2) bIT OS”.

## Validation

- `npm test`: **212 passed**, zero failed/skipped, outside the sandbox. The sandbox attempt reported an integration-test failure and did not finish normally; the unrestricted rerun completed in about seven seconds.
- `npm test --prefix apps/dashboard`: **22 passed** across four files, without network requests. Covers metadata/lease options, exact run payload and submit handler, owner/expiry rendering, command confirmation and timeout, actual approval handlers and in-flight disablement, decision payloads, Stop visibility/payload and update callback, title counts, escaped database text, and subscription cleanup/late results.
- `npm run build --prefix apps/dashboard`: **PASS** (TypeScript, Vite production build and bundle credential scan).
- `git diff --check`: **PASS**.
- The source safety test recursively scans dashboard `src/` and fails if the raw HTML injection property is introduced.
- No authenticated live run or browser screenshot was performed. The following is the manual acceptance procedure.

## Existing backend detail limitation

`src/bitos/dispatch.js` currently persists agent approval `action_detail` with only `run_id`, `request_id`, and `kind`; it discards the worker's structured action detail. The dashboard supports structured command/path detail when present, but existing rows can only display the stored action summary, such as `Write`, `Bash`, or `item/commandExecution/requestApproval`. Executor and machine still resolve from the run/node. Shell summaries still trigger the second click. Exact filenames and command arguments cannot be recovered from these rows. Full “Write dispatch-proof.txt” / “Run command: git status --short” detail for live approvals requires a future backend change to persist that data, outside this task's allowed scope.

## Manual acceptance at http://127.0.0.1:5173

1. In this worktree run `npm run dev --prefix apps/dashboard`. Use the existing dashboard environment configuration. Open http://127.0.0.1:5173 and sign in as the MACBOOK node owner. Select the intended workspace.
2. Confirm MACBOOK is online, has `run_agent` and advertises the `sandbox` alias. Create/open an inbox task. In Run on a machine select MACBOOK, an advertised executor, `sandbox`, and an available lease. Use a prompt such as: “Write dispatch-proof.txt containing phase2c dashboard proof in the sandbox repository, then report what you wrote. Ask for permission before writing.” Press Run once.
3. Confirm a requested/awaiting-approval run appears. Close the task panel to access Approvals. Verify the run card's machine, executor, alias, lease and prompt, then Approve. The tab count and board badge should update.
4. When the agent write approval arrives, Approve it once. The existing backend may show only the write tool name, as described above. For a shell approval, confirm the first click says “Approve command?” and the second click within five seconds decides it; waiting longer resets confirmation.
5. Reopen the task. Watch status, branch, live event times/kinds/summaries and the eventual summary. Scroll upward while events arrive: the log should preserve position; return to the bottom to resume following.
6. Request a second run with a longer task, approve the run, and reopen its task panel. While dispatched/running, press Stop. Verify disabled “Stopping…” until the status changes to stopped/another terminal state.
7. In a separate signed-in non-owner session, verify pending cards have waiting text and no Approve/Deny, and active runs have no Stop. Let a pending card expire: it should show Expired without buttons. Deny a fresh run and verify the status changes.
8. Narrow the viewport below 640px while an approval is pending; Approvals should be first. Close/reopen the task panel, switch workspaces and sign out to exercise subscription cleanup. Database strings containing HTML must appear literally.

Commit this work only; do not merge.
