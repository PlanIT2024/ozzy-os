# Dispatched run disconnect stability

## Findings and evidence

Run `a2a797eb-c0e6-4e7d-a294-f38554aec838` stopped after 12 seconds despite a 20-minute lease and `stop_requested=false`. The old summary identifies only the generic manager stop path, not its caller. The supplied logs do **not** establish a unique historical cause. No installed checkout, private logs, environment, database or service was accessed during this investigation.

The immediate disconnect-related stop path in the original code is:

`src/node/index.js`: handshake timeout (10 seconds), E2E receive error, rejection, or fatal transport error → `fatal()` → `stop()` → `AgentBridge.close()` → coordinator `local.shutdown` → `AgentManager.stopAll()` → default `stop(id)` → `agent.finished {status:'stopped', summary:'stopped\nNo tracked changes'}`.

This bypassed the two-minute loss budget. An actual SIGTERM/SIGINT also takes the shutdown path and produces the same summary. Its normal exit is zero; the original fatal listener sets exit code **1**, so a reported last exit of zero does not prove the handshake path fired. The ten-second process-group grace period is consistent with a stop requested early in a 12-second run, but is not proof of a particular caller. The supplied two reconnect timestamps precede the run. Manual kickstarts, policy disable, and explicit local shutdown cannot be distinguished retrospectively from this summary. Lease expiry and the two-minute loss rule cannot explain the reported timing under their configured defaults.

An ordinary relay close (including 1006) already installed a referenced reconnect timer; it did not deliberately exit the node. The checked-in launchd template has `KeepAlive.SuccessfulExit=false`, so it does not promise automatic restart after a clean exit either. The premise that every relay close caused a clean exit/restart is unsupported by this code.

A second defect was reproduced **before fixing**: disconnect a node's coordinator socket, reconnect using a new socket, and recover online before the deadline. Each socket had a random owner; the old owner's loss timer survived recovery and stopped runs. The new regression failed with “brief coordinator disconnect must not stop a run.” This defect normally fires after two minutes, so it does not independently explain this 12-second incident.

## Changes

- E2E timeouts, rejected sessions and transport failures now clear the encrypted session and reconnect without closing the agent bridge or stopping the node. A relay close retains its referenced retry timer. Authentication remains fail closed: retries grant no execution access.
- Relay reconnect delay grows exponentially from one second to a hard 30-second cap with jitter. It resets after a connection survives 60 seconds, preventing rapid connect/close cycles from resetting backoff indefinitely. Socket errors are included in one close log with code and reason.
- The bridge reconnects to its coordinator automatically. Node sockets share a stable local owner, so recovery cancels the existing loss timer; replacement socket closures cannot disconnect the new owner. Terminal clients retain independent ownership.
- Every run message has a monotonically increasing `sequence`. The coordinator retains the latest 2,048 node messages across socket replacement. The node retains up to 2,048 unacknowledged messages and replays in sequence order after E2E recovery, including completion during a drop. Overflow evicts the oldest message; node overflow is logged. These are bounded in-memory buffers, not durable crash recovery.
- `src/brain/nodeHub.js` necessarily changed to acknowledge messages and suppress duplicate delivery using machine + runId + sequence. Its bounded 4,096-run high-watermark map survives session reconnects within the brain process. Legacy messages without sequence remain compatible. This is application delivery acknowledgement, not a transaction acknowledging a committed database write; simultaneous process crashes, database persistence failures, and buffer overflow are outside the replay guarantee. No schema change was needed; the existing dispatcher already writes the finished summary to `agent_runs.summary`.
- Stops include `reason` and a summary prefix: `user_stop`, `lease_expired`, `relay_loss_2m`, `node_shutdown`, `coordinator_lost`, or `policy_disabled`. Lease status remains `expired`; other cancellation statuses remain `stopped`. Executor success/failure retains its own diagnostic.
- The node entrypoint timestamps every stdout/stderr line with ISO time, including multiline errors; logs process start, requested shutdown, and exit code/reason. SIGKILL cannot run an exit handler. Existing historical log lines are not rewritten.

No relay server, dashboard, migration, environment file, installed checkout, or deployed service changed. The brain hub change is required for acknowledged, idempotent replay. The shared relay client change also applies to the brain's outbound connection.

## Relay 1006 assessment

Both `RelayClient` and `relay/index.js` send WebSocket pings every 30 seconds. Both register pong handlers, and `ws` automatically responds to incoming pings. Client watchdog is 90 seconds; server terminates a connection that misses its next sweep. These keepalives already existed and were retained.

[Railway's current specifications](https://docs.railway.com/networking/public-networking/specs-and-limits) explicitly exempt WebSockets from HTTP duration and inactivity limits. The HTTP idle timeout is therefore not evidence of a WebSocket idle cutoff. Code 1006 means the connection ended without a close frame; it does not identify who severed it. My working hypothesis is an intermittent TCP path/edge interruption (Wi-Fi, VPN, NAT, or Railway edge/origin lifecycle), rather than Mac sleep, which the supplied pmset evidence excludes for this run. Available evidence cannot select among those causes. Correlate the new timestamped close logs with relay deployment/restart logs and Mac network changes before attributing it to a specific component. Increasing heartbeat frequency would not establish or fix a proven cause here.

## Validation

`npm test`: **217 tests, 205 passed, zero failures, 12 skipped**. The skips are existing Linux GI/desktop portal tests unavailable on macOS. No external network is used by the new tests. Unix socket tests require execution outside the restricted sandbox. `git diff --check` passed.

Coverage includes real executor process-group termination for lease expiry, user stop, long relay loss, shutdown and policy disable, with assertions on both reason and summary; coordinator loss reason; the reproduced coordinator socket replacement failure; completion during a brief relay drop; replay after reconnect and a deliberately lost ACK without duplicate application delivery; E2E timeout without bridge shutdown; and a real subprocess remaining alive solely because the relay retry handle is referenced. Loss budgets are scaled in the tests (50 ms drop against 1,200 ms budget represents 5 seconds against 120 seconds); production default remains exactly 120,000 ms. Existing encrypted transport tests verify unknown/wrong keys remain unauthenticated while the node retries.

## Merge and deployment — instructions only

Do this during an idle window: service shutdown intentionally stops active runs. Do not start a second brain from this worktree. No environment edits or migrations are required.

1. Review this branch and merge through your normal PR workflow. If merging locally, in the target branch's checkout:

   ```sh
   git fetch origin
   git switch main
   git pull --ff-only origin main
   git merge --no-ff phase2a-stability
   git push origin main
   ```

   If the branch is on another machine, push `phase2a-stability` first and merge `origin/phase2a-stability`. Substitute your actual integration branch if it is not `main`. This change has been committed but **not merged or pushed** by the agent.

2. On the Mac, stop the installed node gracefully, then update its checkout:

   ```sh
   launchctl bootout "gui/$(id -u)/com.ozzy.bit-node"
   cd ~/ozzy-os
   git status --short
   git fetch origin
   git switch main
   git pull --ff-only origin main
   npm ci
   ```

   Resolve any installed-checkout changes before switching/updating; do not reset or overwrite them. Preserve all environment, data and key files.

3. The detached coordinator must also restart to load the fix. With no runs active, inspect its PID and command:

   ```sh
   cat data/agent-coordinator.lock/pid
   ps -p <printed-PID> -o pid=,command=
   ```

   Only if this is the installed checkout's `src/node/agent/server.js`, run `kill -TERM <printed-PID>`. Wait for `data/agent-coordinator.lock` to disappear. Do not delete a live/stale lock blindly. If the coordinator is already absent, skip this step. Then start the LaunchAgent:

   ```sh
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ozzy.bit-node.plist"
   launchctl kickstart "gui/$(id -u)/com.ozzy.bit-node"
   npm run service:status -- --node-only
   tail -f data/node.log data/node-error.log
   ```

   Confirm a new timestamped process-start line and authenticated connection. The coordinator is started lazily by the node. Do not use a forced kickstart as a reconnect test: it intentionally kills the process.

4. On OZZY-AI, update the brain hub and local node/coordinator together:

   ```sh
   systemctl --user stop bit-brain.service bit-node.service
   cd ~/ozzy-os
   git status --short
   git fetch origin
   git switch main
   git pull --ff-only origin main
   npm ci
   ```

   If this machine has a detached agent coordinator, inspect and gracefully terminate it as in step 3. Then:

   ```sh
   systemctl --user start bit-brain.service bit-node.service
   systemctl --user status bit-brain.service bit-node.service
   journalctl --user -u bit-brain.service -u bit-node.service -f
   ```

   Confirm MACBOOK advertises `status, run_agent`. Restarting the brain clears the in-memory replay deduplication map, so deploy while idle, before the new test run.

5. In the existing dashboard, sign in as the node owner, open the same workspace and create a MACBOOK `claude_code` run using the already allowed folder alias (for example `sandbox`) and a 20-minute lease. Ask it to create `stability-proof.txt`, write a short completion message, and neither commit nor push. Approve the initial dispatch and only the expected tool requests. Record its run ID.

   During execution, briefly disable the Mac's network for about five seconds, then restore it. Expect timestamped close/retry/connect logs with the **same node PID**, no shutdown log, and a final `done` summary in the dashboard. Ensure the task events and completion appear once, even if completion occurred during the drop. Repeat with a longer task and a loss exceeding two minutes: expect `stopped` and a summary beginning `relay_loss_2m:` after reconnection. Finally test dashboard Stop: expect `user_stop:`. Do not force-restart the node during these disconnect tests.

   If the dashboard does not show progress, use the existing CLI from its configured checkout to distinguish delivery from display:

   ```sh
   npm run bitos -- watch <runId>
   npm run bitos -- approvals
   ```

   Save the run IDs and timestamped node/brain logs for comparison with the original incident. Live dashboard tests and deployment were not performed here.
