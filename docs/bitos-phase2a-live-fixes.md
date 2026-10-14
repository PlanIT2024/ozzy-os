# Phase 2a live-harness fixes

The Codex filter now recognizes bare or system-path `sh`, `bash`, and `zsh` launchers with exactly `-c`/`-lc` and one command string. It unwraps them without execution, splits separators outside quotes, and checks every inner command. The observed `/bin/zsh -lc 'pwd; rg --files -g AGENTS.md -g codex-proof.txt'` reaches normal y/N approval. Read-only commands are not auto-approved. Sensitive paths, outside-worktree access, symlink escapes, deployment/push, sudo, downloaded shell execution, forced recursive removal, Git mutation, and shell indirection remain denied. Malformed or unknown wrappers fail closed.

Denied Codex command/file approvals always reply `decline`, including when `availableDecisions` is absent. They do not cancel or interrupt the turn. Tests demonstrate denial followed by an allowed command and successful completion; a real failed turn still reports failure.

Completed agent text is emitted as `kind: message`. Token fragments are not emitted. Generic activity and command summaries share a one-per-second progress limit per run; Claude tool activity uses the same limit. Absolute worktree paths become relative, outside paths become `[path]`, and known slash commands such as `/login` remain readable. Structured path fields still redact outside paths even if they resemble a slash command.

Validation: `npm test` — **186 tests, 174 passed, 0 failed, 12 Linux-only skips**. All **33 Phase 2a tests** passed with fake executors and no model or external-network calls. Legacy node tests now inject a disabled agent policy so an enabled local policy cannot advertise new capabilities to the old test brain or connect test shutdowns to the live coordinator. New coverage includes the exact live command, both shell flags, all requested read commands, quoted separators, wrapped deny cases, decline-and-continue, event burst throttling, paths with spaces, and `/login` rendering.

The coordinator caches code. After existing development harness runs finish, stop that coordinator before retrying so it loads the fixes:

```sh
cd /Users/ozzy/ozzy-os-2a
kill -TERM "$(cat data/agent-coordinator.lock/pid)"
```

Wait for `data/agent-coordinator.lock` to disappear, then rerun the harness commands. The next harness starts the updated coordinator; the existing local policy is preserved. This command targets only this development checkout's coordinator, not the installed node in `~/ozzy-os`.
