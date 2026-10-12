# bIT OS mirror inventory

Inventory recorded before implementation on `bitos-supabase-sync`.
The brain's existing state directory is `<root>/data` (`src/shared.js`,
`ROOT`, `readJSON`, `saveJSON`). Discord remains the decision authority.

| Lifecycle | Existing path and functions | Mirror table |
| --- | --- | --- |
| Relay connections and encrypted node authentication | `src/transport/relayClient.js`, `RelayClient`; `src/brain/nodeHub.js`, `NodeHub.receive`, `NodeHub.message` (authenticated `hello`) | `nodes` |
| Heartbeat and capabilities | `src/node/index.js`, `startNode` heartbeat interval; `src/brain/nodeHub.js`, `NodeHub.message` | `nodes` (60-second mirror throttle) |
| Disconnect, relay loss, stale connection | `src/brain/nodeHub.js`, `NodeHub.disconnect`, constructor relay handlers and 90-second sweep | `nodes` |
| Brain startup | `src/brain/index.js`, `runBrain` | `nodes` (owner offline reset before live updates) |
| Task/thread creation | `src/brain/discord.js`, `createDiscord` messageCreate callback, `runScheduled`; `src/brain/runner.js`, `Runner.run` | `tasks`, `task_events` |
| Task execution, completion, failure, shutdown cancellation | `src/brain/runner.js`, `Runner.run`, `Runner.close` | `tasks`, `task_events` |
| Approval request and wait | `src/brain/discord.js`, `ApprovalRelay.request`; callers in `src/brain/permissions.js`, `createPermissions`, `decide`; `src/brain/screens.js`, `ScreenGrants.context.authorize`; `src/brain/controls.js`, `ControlGrants.context.authorize` | `approvals`, `tasks`, `task_events` |
| Owner button decision, timeout, cancellation | `src/brain/discord.js`, `ApprovalRelay.handle`, `ApprovalRelay.request.finish`, `ApprovalRelay.close` | `approvals`, `tasks`, `task_events` |
| Control window start and end | `src/brain/controls.js`, `ControlGrants.on`, `off`, `arm`, constructor control_closed handler | `leases` (`control`) |
| Screenshot window start, early end, natural expiry | `src/brain/screens.js`, `ScreenGrants.on`, `off`, `grant` | `leases` (`watch`); natural expiry already represented by expires_at |
| Input actions | `src/brain/controls.js`, `ControlGrants.context.execute`; `src/brain/nodeHub.js`, `NodeHub.request` (`input_action`); execution in `src/node/input/index.js` | `task_events` (brain metadata only; typed text length) |
| Screenshot capture | `src/brain/screens.js`, `ScreenGrants.context.capture`; `NodeHub.request` (`screen`); execution in `src/node/screen/index.js` | `task_events` (no pixels or upload) |
| Model call and reported cost | `src/brain/runner.js`, `Runner.run`, `queryFn` iteration and result handling | `task_events` |
| Shell | `src/brain/permissions.js`, `BUILTINS`, `createPermissions`: Bash is excluded; `NodeHub.request` allows no shell method | No current shell execution to mirror; future shell hook would write `task_events` |
| Tool outcomes/status | `src/brain/permissions.js`, `createPermissions` PostToolUse / PostToolUseFailure hooks | `task_events` |

## Repository differences and prerequisites

- At inventory time migration 0001 was absent. The supplied schema is now
  committed as `a586bbf`. Its generated event identity and before-insert
  active-lease trigger use migration 0003 for ordinary replay-safe upserts.
- Tasks are serialized conversational runs, including DMs and scheduled
  threads. There is no separate task entity or explicit task cancellation
  API. Mirror one stable task UUID per Discord channel/thread, with run
  status events for subsequent turns.
- Screen grants expire by timestamp checks; control grants also have expiry
  timers. Mirroring must not introduce a new local permission policy.
- `WebLedger` tracks taint, not secret redaction. `Transcript.safeText`
  strips images and large encoded strings but is not a credential detector.
- Both supplied systemd units load the same `.env`. Supabase credentials
  must use a separate brain-only environment file; placing the service role
  key in that shared file would expose it to the node.
- Units target `%h/ozzy-os`; this checkout is `/home/ozzy/ozzy-os-bitos`.
  Live proof requires checking the installed units before restarting.
