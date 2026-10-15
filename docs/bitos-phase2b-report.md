# bIT OS Phase 2b

Implemented in the phase2b-dispatch worktree. No live checkout, environment files, dashboard UI, or Discord code was changed. The live test has not been run.

## Migration 0004

`supabase/migrations/0004_agent_runs.sql` adds client UUID agent runs, task/node references, the restricted executor enum, bounded prompt and lease, lifecycle status, requesting user, stop flag, branch/summary and timestamps. It adds task/status indexes and Realtime publication membership.

Workspace viewers can read runs through their task. Workspace members can insert requested runs only as themselves against a visible node. Users cannot delete runs. A trigger permits the node owner to change only stop_requested from false to true and stamps updated_at. The approvals trigger permits only an unexpired pending-to-approved/denied decision, requires the signed-in deciding user, stamps decided_at at database time, and rejects changes to other fields. Service-role writes bypass these guards.

## Design

`src/bitos/dispatch.js` is disabled unless BITOS_DISPATCH=1; disabled means no client, reads, timers, or subscriptions. Brain settings are captured once by the existing sync startup and scrubbed before loading the SDK/Discord. The dispatcher uses the existing brain-only Supabase client factory. It independently scopes task scans and Realtime subscriptions to workspace memberships for BITOS_OWNER_USER_ID and requires the node to belong to that owner. Polling every 15 seconds discovers new tasks and refreshes subscriptions.

The authenticated hub now accepts run_agent advertisement, agent RPCs, and agent events. On connect/capability change the dispatcher fetches agent.capabilities over E2E, keeps that response in memory, and mirrors executor names, folder aliases, and limits into nodes.metadata.agent. A polling retry covers the race with the existing node mirror's initial insert. Database metadata is never used to authorize execution. No folder paths are mirrored.

A requested run must match the explicit, case-insensitive BITOS_AGENT_NODES allowlist and the authenticated node's advertised executor, folder alias and lease limit. The empty allowlist authorizes nothing, including OZZY-AI. The node still enforces local policy and concurrency. Valid requests are conditionally claimed as awaiting_approval before a ten-minute risky approval is created; invalid requests become denied with a summary reason.

Realtime payloads only wake the scanner. Dispatch re-reads approval/run/node/task/membership rows, checks approval identity, expiry, deciding owner, task/node/run association, capabilities and stop flag, then conditionally claims the awaiting run before sending agent.run with its UUID. A single serialized queue prevents overlapping local scans. No approval is automatic. Node permission requests create separate ten-minute approvals keyed by run/request IDs. Verified decisions send agent.decide; denied/expired decisions send deny. Completed decisions are marked agent_decided to prevent replay.

Stop flags send agent.stop; pre-dispatch stops finish immediately. Agent events enter the existing task_events schema with the existing redactor. Finished messages update run branch/summary/status and task done, waiting_on_you on failure, or cancelled on stop/expiry. Only events from the matching authenticated node count. Runs recovered as dispatched/running receive a two-minute confirmation window before failure with summary `brain restarted`. Individual run failures do not stop the remaining poll batch.

The CLI reads only the dashboard's VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY and signs in with prompted credentials. Password input is hidden; credentials/session are not persisted. It creates an inbox task and run, decides pending approvals interactively, requests owner stops, and polls events/final status. Multiple member workspaces prompt for a workspace UUID.

Crash behavior fails closed: a crash between claiming awaiting_approval and inserting its approval can leave an inert awaiting run; a crash after claiming dispatched never automatically replays execution. Review/stop an inert request and submit a new run. Dispatch RPC failure records failure rather than retrying a possibly accepted execution.

## Verification

- Full `npm test`: 205 passed, 0 failed, 0 skipped. Includes 19 dispatcher cases using fake Supabase and fake node, without network: spoofed owner, expiry, mismatched/other run, approved Realtime vs pending DB, allowlist/default denial, capabilities, happy path/nested decisions, redacted events, stop, finish mappings, restart confirmation/timeout, and disabled zero reads/subscriptions.
- Migrations 0001–0004 applied successfully to disposable Docker Postgres 16 with stub auth/storage/publication. SQL assertions passed for member insertion, viewer read/no insertion, owner-only stop, immutable prompt, no stop reversal/delete, spoofed and mutable approvals, server-stamped decisions, no redecision, expiry rejection, and service writes.
- Reproduce SQL checks: `node scripts/check-phase2b-sql.mjs`. Requires Docker and the postgres:16 image (downloads if absent); creates and removes its own disposable container. Fixtures are in test/fixtures/phase2b-*.sql. The stub does not exercise hosted Realtime delivery; the live steps below do.
- Syntax checks and `git diff --check` passed. Socket/child-process tests require execution outside the restricted development sandbox.

## Exact live steps — not executed

1. After reviewing and merging this commit, deploy the merged code into the installed `~/ozzy-os` checkouts on OZZY-AI and the Mac using your normal deployment process. The OZZY-AI service runs from that checkout, not this worktree. Do not start a second brain from this worktree.
2. In the Supabase project's SQL editor, paste and run all of `supabase/migrations/0004_agent_runs.sql` after migrations 0001–0003. Confirm agent_runs appears in the supabase_realtime publication. Existing brain settings must identify the correct owner, project and workspace, with BITOS_SUPABASE=1 and the existing service credential confined to the brain.
3. On OZZY-AI, manually add these lines to `~/ozzy-os/.env.brain`:

   ```dotenv
   BITOS_DISPATCH=1
   BITOS_AGENT_NODES=MACBOOK
   ```

   Restart the installed brain:

   ```sh
   systemctl --user restart bit-brain.service
   journalctl --user -u bit-brain.service -f
   ```

4. In a local terminal on the Mac (not SSH), use the installed node checkout and enable policy:

   ```sh
   cd ~/ozzy-os
   npm run agent:enable
   ```

   Choose `codex` (or `claude_code,codex` if both are installed/logged in), alias `sandbox`, and the absolute path of the intended existing sandbox Git repository. Choose maximum concurrent `2` and maximum lease `60`. Restart the installed node:

   ```sh
   launchctl kickstart -k "gui/$(id -u)/com.ozzy.bit-node"
   npm run service:status -- --node-only
   ```

   Confirm the node is named MACBOOK, is online through the existing E2E relay, and its Supabase row advertises run_agent with metadata.agent.folders containing only aliases including sandbox.
5. From this worktree, ensure `apps/dashboard/.env.local` already contains the project's public URL and publishable key. Sign in at each CLI invocation as the Mac node owner, who must also be a member of the task workspace:

   ```sh
   npm run bitos -- run --node MACBOOK --executor codex --folder sandbox --lease 5 --prompt "Create phase2b-proof.txt containing hello from Phase 2b. Do not commit or push. Summarize the change."
   ```

   Save the printed run UUID. In another terminal:

   ```sh
   npm run bitos -- watch <runId>
   npm run bitos -- approvals
   ```

   Inspect the initial run approval and answer y only if correct. Run `npm run bitos -- approvals` again whenever the agent requests permission; approve only expected sandbox operations. Confirm awaiting_approval → running → done, task_events, branch and summary. Inspect the retained sandbox worktree/branch locally. Repeat with a longer request and use:

   ```sh
   npm run bitos -- stop <runId>
   npm run bitos -- watch <runId>
   ```

   Confirm stopped (or already finished), task cancelled for stopped, and no new execution after expiry/denial. These commands are instructions for the later live test; none were executed during Phase 2b implementation.

## Dispatcher failure diagnostics follow-up

Dispatcher failures now emit a structured, redacted record with operation, table, and Supabase code/message/hint. Database errors retain their original fields through query wrappers; node RPCs identify their method and the nodes table. Startup, polling, per-run/per-approval processing, dispatch failures, agent events, Realtime errors and unsubscribe rejections use the same reporter. Non-database failures carry null code/hint when unavailable; client initialization has a null table. No rows, request parameters, stacks or Supabase details are serialized. Known run prompts and their approval previews are removed from diagnostic strings before the existing redact() removes credentials. Brain startup no longer adds a second generic error message.

Validation: `npm test` passed 212 tests, zero failures or skips. Seven new fake-client regression tests cover startup/client errors, repeated polling and thrown transport errors, credential/prompt redaction, per-run/approval/event persistence failures, RPC failures, and Realtime error callbacks. No live service was restarted during this change.
