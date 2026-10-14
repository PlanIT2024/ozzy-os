# bIT OS Phase 2a — node agent execution

Implementation branch: `phase2a-run-agent`. This checkout is `/Users/ozzy/ozzy-os-2a`.
The installed node in `/Users/ozzy/ozzy-os` is not enabled, restarted, or modified by these commands. No brain, relay, `src/bitos`, dashboard, or environment-file changes are part of this phase. Committing this linked worktree necessarily updates its shared Git object/ref metadata; it does not change the main checkout.

## Design

`src/node/agent/policy.js` owns validation and the local policy format. `npm run agent:enable` requires a local interactive TTY and refuses SSH sessions. It writes `data/agent-policy.json` atomically with mode 0600. The policy contains `enabled`, an executor allowlist, `projects: [{alias, absolutePath}]`, `maxConcurrent` (default 2, maximum 4), and `maxLeaseMinutes` (default 60, maximum 120). Projects must be existing repository roots with a HEAD; paths are canonicalized, and `/`, the home directory, `.ssh`, `.env`, and `data/keys` are refused, including symlink aliases. Missing, malformed, insecurely permissioned, or disabled policy fails closed. The CLI alone writes this policy. Neither encrypted RPC nor the coordinator has an enable/edit-policy method.

`server.js` is a per-checkout coordinator, started lazily by the node bridge or harness. A 0700 lock directory elects one coordinator; its Unix socket is mode 0600. Every terminal connects to this same manager, so concurrency and duplicate-ID checks apply across processes and executors. Accepted IDs are reserved durably under `data/agent-runs/`. A stale coordinator lock fails closed rather than risking two managers. Node processes using a different checkout have separate policies and coordinators.

`manager.js` reserves capacity before setup, starts the lease at acceptance, and creates `<repo>/.bit-worktrees/<runId>` on `bit/<runId>` from the current HEAD. It adds `.bit-worktrees/` to the repository's Git info/exclude file, never `.gitignore`. Setup Git commands disable hooks. No push is performed. The original checkout and index are untouched. Worktree and branch remain after every result; `agent.finished` includes the branch, `git diff --stat` against the starting HEAD (including any committed changes), and a separate untracked-file list. Git's diff stat does not include untracked content.

Each executor runs inside a detached worker process group. The only inherited environment variables are `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `SHELL`, and `TMPDIR`. The coordinator and worker do not load dotenv. API keys, tokens, relay credentials, Node injection variables, and executor config-directory overrides are not forwarded. HOME lets the executors use their existing local login state; no API key is added.

Stop and expiry send SIGTERM to the whole process group, wait 10 seconds, then send SIGKILL to the group even if its leader has exited. Capacity stays occupied through that grace interval. The first terminal status wins, preventing completion from overwriting `expired` or `stopped`. A worker watchdog also enforces the accepted deadline and kills its group after coordinator IPC loss. Node shutdown stops all coordinator runs; losing the node's E2E connection for two minutes does the same, with recovery cancelling the timer. A lost harness connection stops only that harness's unfinished runs after two minutes. Closing a completed harness cannot stop another terminal's task. Policy disable is polled within one second and the disable CLI explicitly waits for all processes to stop.

## Executors and approvals

Codex uses `codex app-server --listen stdio://`, followed by `initialize`, `initialized`, `thread/start` with the worktree cwd, `sandbox: workspace-write`, `approvalPolicy: untrusted`, and `turn/start`. There is no `-c approval_policy` flag. This follows the local `~/Downloads/codex-probe.mjs` and `~/agent-ops-bot/index.js`, checked against the [official app-server protocol](https://learn.chatgpt.com/docs/app-server). Command and file approval replies use single-action `accept` or `decline`; permission-widening requests receive empty permissions. File approvals are checked against cached item change paths. Unknown server requests fail closed. Completed agent messages become message events. Token deltas produce no message text; generic activity and command summaries are limited to one progress event per second. Only a completed turn reports success.

Claude Code uses the installed `@anthropic-ai/claude-agent-sdk` query API, the worktree cwd, `permissionMode: default`, and `canUseTool`. A PreToolUse hook applies the same checks even when the CLI would otherwise allow a tool automatically. Only Read, Glob, and Grep can auto-allow, after path checks. Read-deny rules also cover `.env*`, `data/keys`, and `~/.ssh`; project/user settings are not loaded. The OS sandbox must be available; it never silently falls back to unsandboxed commands. Failures preserve the SDK diagnostic and explain the existing Claude Code subscription login requirement (`claude`, then `/login`) and sandbox requirement. Actual subscription entitlement/login acceptance is a manual harness check; fake tests do not establish it. The implementation never switches to an API key.

Every pending approval has a node-owned ten-minute deadline; lack of a decision means deny. Decisions must match both runId and requestId. Stopping resolves outstanding approvals as denied. Before any user prompt, the manager denies push/deploy/publish, railway/vercel/wrangler, sudo, downloaded shell execution, sensitive paths, outside-worktree paths, Git metadata access, and permission widening. Path checks resolve symlinks, including existing ancestors of new files. Shell checks unwrap known sh/bash/zsh -c/-lc launchers and inspect each inner simple command. They conservatively also refuse all recursive forced removals, shell expansion/indirection, selected interpreter execution, and Git checkout/configuration mutation. These extra refusals cannot be overridden by an `allow` reply.

These are conservative approval checks layered on the executors' sandboxes, not a general shell-language proof or a VM boundary. A human-approved repository script can itself contain arbitrary code; use a trusted disposable test repository. Codex's native trusted commands and in-workspace edits may not generate approval requests. This implementation checks requests the app-server sends; it does not claim to intercept every internal Codex file read. Filesystem worktrees isolate Git changes, not the user's OS identity.

## Node protocol and terminal harness

The node advertises `run_agent` only while local policy is enabled. Its existing authenticated, encrypted request dispatcher handles:

- `agent.capabilities`: executor names, folder aliases, concurrency limit, lease limit.
- `agent.run`: `{runId, taskId, executor, folderAlias, prompt, leaseMinutes}`.
- `agent.stop`: `{runId}`.
- `agent.decide`: `{runId, requestId, decision: "allow" | "deny"}`.

Unsolicited encrypted messages are `agent.event`, `agent.approval_request`, and `agent.finished`, with the fields specified in the phase prompt. No full project path appears in capabilities; executor output, approval detail, and errors redact outside absolute paths before crossing the wire. Worktree paths are relative and slash commands such as `/login` remain readable. Branch names and relative filenames are preserved. Unknown fields on a run are rejected, including caller-supplied cwd/path fields. There is no remote policy mutation route. Brain dispatch and capability acceptance belong to Phase 2b; the existing brain is unchanged.

`npm run agent:try -- ...` connects to the same coordinator and invokes the same `AgentManager.request` path as encrypted RPC. It prints JSON events and asks each approval as `y/N`; only an explicit `y` allows. Ctrl-C requests a stop and waits for the final result. A failed/stopped/expired run exits nonzero. The harness does not need a brain, relay, node keys, or environment files.

## Tests

Run:

```sh
cd /Users/ozzy/ozzy-os-2a
npm test
```

The new `test/phase2a-agent.test.js` uses fake executors and local-only transports. Coverage includes absent/disabled/private policy, forbidden project paths, alias-only capabilities, executor/lease/concurrency rejection, durable duplicate IDs, independent worktrees and unchanged main checkout/index, environment scrubbing, expiry/stop/shutdown/disable/relay-loss process-group kills (including a real stubborn descendant), reconnection timing, approval timeout and scoped decisions, pre-prompt denials, sensitive/symlink paths, Codex protocol and failure replies, Claude login failure reporting, two coordinator clients, terminal y/N and Ctrl-C handling, completed-harness disconnect isolation, symlinked Git exclude refusal, and the actual node's encrypted RPC/events and dynamic opt-in advertisement. Tests shorten deadlines but preserve production timing paths. No real model calls are made.

The existing suite needed three Mac portability corrections: canonical temporary fixture paths, `process.execPath` instead of `/usr/bin/node`, and explicit non-Linux skips for 12 tests that import Linux GI/desktop-portal APIs. Those tests remain enabled on Linux; portable tests are not skipped. Final full run on this Mac: **180 tests, 168 passed, 0 failed, 12 skipped** (the Linux-only tests), in about 17 seconds. All 27 Phase 2a tests passed. Local socket tests require permission to bind Unix/loopback sockets when run inside a restrictive development sandbox.

## Exact local test commands

Run these in a **local Mac terminal**, not SSH. Keep using this development checkout; do not run these commands from `~/ozzy-os`.

Create a fresh disposable repository (the directory should not already contain a project):

```sh
mkdir -p /Users/ozzy/bit-phase2a-demo
git -C /Users/ozzy/bit-phase2a-demo init
git -C /Users/ozzy/bit-phase2a-demo -c user.name='Phase 2a Test' -c user.email='phase2a@example.invalid' commit --allow-empty -m 'Initial test repository'
cd /Users/ozzy/ozzy-os-2a
npm run agent:enable
```

Enter these answers:

```text
Executors: claude_code,codex
Project alias: demo
Existing git repository absolute path: /Users/ozzy/bit-phase2a-demo
Add another project?: N
Maximum concurrent runs: 2
Maximum lease minutes: 60
```

Use the existing machine logins. If an executor reports missing login, run `codex login` or run `claude` and `/login` locally, then retry. Do not add API keys or edit an environment file.

Terminal 1:

```sh
cd /Users/ozzy/ozzy-os-2a
npm run agent:try -- --executor claude_code --folder demo --prompt "Create claude-proof.txt containing hello from Claude. Do not commit or push. Summarize the change." --lease 5
```

Terminal 2, while Terminal 1 is running:

```sh
cd /Users/ozzy/ozzy-os-2a
npm run agent:try -- --executor codex --folder demo --prompt "Create codex-proof.txt containing hello from Codex. Do not commit or push. Summarize the change." --lease 5
```

Answer `y` only for expected in-worktree edits/commands. Each terminal prints a different runId and `bit/<runId>` branch. Both runs share the limit of two, but use separate worktrees. To inspect their retained files and confirm the original checkout is clean:

```sh
git -C /Users/ozzy/bit-phase2a-demo worktree list
git -C /Users/ozzy/bit-phase2a-demo status --short
ls -la /Users/ozzy/bit-phase2a-demo/.bit-worktrees
```

The new files are untracked within their individual worktrees, not in the original checkout. Review them at the paths printed by `git worktree list`.

Disable execution and stop any remaining runs:

```sh
cd /Users/ozzy/ozzy-os-2a
npm run agent:disable
```

The idle coordinator may remain running; it has no capability to enable policy. To stop that coordinator too, after disable has completed:

```sh
kill -TERM "$(cat /Users/ozzy/ozzy-os-2a/data/agent-coordinator.lock/pid)"
```

After an abrupt coordinator crash, a subsequent harness fails closed on the stale lock. Check its recorded PID and ensure its workers have exited (the disconnect watchdog allows ten seconds) before manually removing only `data/agent-coordinator.lock` in this development checkout. Do not remove a live coordinator's lock or the durable `data/agent-runs` reservations.
