# OZZY OS · bIT (Phase 1)

Standalone personal assistant for Ozzy: Claude Agent SDK brain, owner-only Discord conversations, and authenticated status-only nodes. Nothing imports or accesses PlanIT.

## Setup on OZZY-AI

Use Node.js 22 LTS or newer supported LTS and npm. This checkout was tested with Node 22.23.1. Install dependencies and configure a local environment file:

```sh
cd ~/ozzy-os
npm ci
cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the generated token in `NODE_TOKEN` and `NODE_TOKENS=OZZY-AI:<same-token>`. Set `MACHINE_NAME=OZZY-AI`. Fill in `ANTHROPIC_API_KEY`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `BIT_CHANNEL_ID`, and `OWNER_DISCORD_ID`. Do not commit `.env`. `BIT_MODEL` defaults to the requested `claude-sonnet-5`; the account must have access to that model, or set an accessible Claude model explicitly. `TZ` defaults to America/New_York in the personality and budget logic.

Create a Discord application and bot in the Developer Portal. Enable **Message Content Intent**. Invite it to your server with `bot` and `applications.commands` scopes and these channel permissions: View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Attach Files. The bot needs Attach Files to show complete approval proposals. Ensure #bit permits these permissions. Enable server-member DMs if you want to DM the bot.

```sh
npm run register-commands
npm run brain
```

In a second terminal:

```sh
cd ~/ozzy-os
npm run node
```

The node reports status; it receives no Discord or Claude credentials over the protocol. The brain binds to `127.0.0.1:8787` by default. Both processes stop on Ctrl+C. Run one brain per checkout: `data/brain.lock` prevents concurrent cost/session writers. After a hard crash, the next start reclaims the lock if its recorded PID is no longer running. Live, inaccessible or invalid PIDs remain protected. SIGINT/SIGTERM clean up the lock after shutdown.

## Discord behavior

Only `OWNER_DISCORD_ID` is handled, in #bit, its threads, or DMs. Other senders are ignored without replies. Every owner top-level text message in #bit starts a thread. Replies resume that thread's SDK session; DMs use a session per DM channel. Attachment-only messages are ignored in Phase 1.

- `/machines`: one human-readable line per machine, for example `OZZY-AI 🟢 up 3d · CPU 8% · RAM 6/50 GB · disk 6%`. Disk usage is for the root/system volume, falling back to the first usable volume. Model tools still receive structured status for every usable disk.
- `/mood personality:hype`: saves the default voice. Choices: chill, hype, chaotic, gremlin, sage. Sage overrides it from 22:00 through 04:59 in `TZ`.
- `/budget`: this month's estimated spend and cap.
- `/reset`: clears the current thread/DM session mapping, preserving long-term memory.

Registration is guild-scoped as requested, so slash commands are available in the configured server, not DMs. Ordinary owner DM conversations work. Replies split at Discord's 2,000 UTF-16-unit limit; mentions are disabled.

## Memory, skills and permissions

`bit/memory/profile.md` starts with `Owner: Ozzy`. Fill it in as desired. bIT reads memory for personal questions and can Write/Edit memory. Successful writes emit `📝 noted: <file>`. Persona files are readable but never writable by bIT. Source, `.env`, runtime data and all other paths are denied for both reads and writes.

Only Read, Write, Edit, Glob, Grep and Skill are exposed as built-ins. An in-process MCP server exposes `list_machines` and `machine_status`. Bash, web search and all other tools are excluded. The same policy runs in `canUseTool` and in a mandatory `PreToolUse` hook because SDK auto-approved reads can skip `canUseTool`. Tool decisions and completion/failure events are logged as JSON lines in `data/audit.log`; file bodies and search strings are omitted. Read-only custom tools need no confirmation.

Paths must be explicit and remain within permitted trees. Traversal, symlinks, hard-linked files and special files are rejected. Searches inspect descendant paths too, so a nested symlink cannot leak data. The one exception is the host-created `.claude/skills` discovery alias, verified to point to `bit/skills`. Permission callbacks are application-level checks, not an OS sandbox against other local processes changing files during execution. Do not let untrusted local programs mutate this checkout while bIT runs.

Create skills as `bit/skills/<name>/SKILL.md`. The runner enables only `settingSources: ['project']` and creates `.claude/skills` as a symlink (junction on Windows) to that folder. It supplies an explicit skill allowlist matching the folder names, disables bundled skills and cloud-synced skills/plugins, and rejects other project `.claude` configuration (settings, hooks, plugins and legacy commands). Each skill's frontmatter name must match its folder. User settings and user skills are not loaded; SDK state is isolated in `data/claude`. Discord text is passed as ordinary conversation, so it cannot dispatch Claude Code built-in slash commands. The agent cannot alter settings. SDK subprocess environment excludes Discord and node tokens. `strictMcpConfig` limits MCP loading to the supplied machine server.

Only the owner pressing the Discord ✅ button can authorize a skill change. Chat text such as “approved” or “sounds good” never authorizes a pending write. Every skill write/edit shows the full proposal as an attached JSON file with owner-only ✅/❌ buttons. Denial, cancellation, or ten-minute expiry denies the operation. Paths are checked again after approval. Skills need YAML frontmatter with `name` and `description`; optional `argument-hint`, `disable-model-invocation` and `user-invocable` are accepted. Other metadata, shell preprocessing, hooks and subagent directives are rejected in Phase 1. bIT can create ordinary instruction skills after approval; executing scripts remains out of scope. Keep project settings and manually installed skills under your control.

## Budget and persistence

`data/` and `.env` are gitignored. The brain atomically stores session mappings, preferences and monthly cost totals. SDK transcripts stay in `data/claude`. Back up `data/` and `bit/memory/`; both contain personal information. Memory is tracked in this initial repo, so review it before publishing commits.

Runs are serialized across conversations to prevent concurrent requests racing past the cap. SDK `total_cost_usd` is cumulative on resumed sessions in the pinned SDK; the ledger charges only the increase. Month boundaries use `TZ`. Each query gets `maxBudgetUsd` equal to the remaining balance. The cap blocks new API calls once reached; one in-flight API response can exceed it because cost is reported after generation. It is an estimated local spend gate, not a provider billing limit; unrelated API use is not included.

Before each query, the ledger marks usage uncertain. A final SDK result clears it. After a crash or a run without a cost result, new calls fail closed. Reconcile the relevant session's cumulative total and month's spend against available SDK/provider usage, then set `uncertain` to `false` in `data/budget.json` while the brain is stopped. Do not just clear it without accounting for the missing spend. A failed startup before any API use can be reconciled as zero. `/machines`, `/mood`, `/budget` and `/reset` do not spend API budget.

## Add another machine

Install this repository and Node LTS on Linux, macOS or Windows, then run `npm ci`. On the brain, add a unique token mapping, such as `NODE_TOKENS=OZZY-AI:<token1>,MACBOOK:<token2>`, then restart. Tokens must have at least 16 characters; use independently generated 32-byte random values.

On the new machine configure only `BRAIN_URL`, `NODE_TOKEN`, and `MACHINE_NAME` in its `.env`, and run `npm run node`. Use a reachable private address for `BRAIN_URL` and set `NODE_HUB_BIND` to the brain's private/Tailscale address. Default localhost binding deliberately does not accept remote nodes. Plain `ws://` bearer traffic should stay on localhost or an encrypted private network; use `wss://` behind TLS otherwise.

The stable protocol uses authenticated WebSockets, an identity-bound `hello`, 30-second heartbeats, 90-second offline detection, and `{type:'req', id, method, params}` / `{type:'res', id, ok, result|error}` messages. Requests time out after 10 seconds. Duplicate authenticated connections replace the old socket without marking the new one offline. Nodes reconnect with exponential backoff and jitter and detect dead connections using ping/pong. Only `status` is implemented. To add capabilities later, extend method dispatch and authorization while retaining the envelope; no screen, input, camera or shell placeholder exists.

Status includes uptime seconds, CPU load percent/core count, memory bytes, filesystem bytes/usage, battery if present, logged-in users, node process user, and OS version. Pseudo/system mounts such as efivars, `/boot/efi`, tmpfs and snap loop devices are excluded. Some machines have no interactive login or battery; those fields can be empty/null. Node connection logs appear only when the connection state changes; failed retries do not repeat connection messages.

## Optional user systemd service

Save as `~/.config/systemd/user/bit-brain.service`, adjusting the home and Node executable paths (`command -v node`; nvm installations usually need an absolute version-specific path):

```ini
[Unit]
Description=bIT OZZY OS brain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ozzy/ozzy-os
ExecStart=/usr/bin/node /home/ozzy/ozzy-os/src/brain/index.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

The application reads `.env` itself. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now bit-brain
journalctl --user -u bit-brain -f
```

Optional `loginctl enable-linger "$USER"` keeps user services running after logout. No service is installed automatically.

## Runtime logs

The brain logs `Discord connected as <tag>` on ready and one debug line per incoming message/interaction with author, channel and filter results. Command failures receive an in-character response and full console/audit diagnostics. Login and fatal gateway errors stop the brain with a non-zero exit status after cleanup; disallowed intents include a Developer Portal hint. Temporary gateway disconnects retain Discord’s normal reconnect behavior.

## Validation

Run `npm test`. Tests use temporary directories, a real local WebSocket hub and systeminformation node, and mocked Discord/SDK boundaries without API spend. See [PROOF.md](PROOF.md) for results and the live acceptance checklist.

Implementation reference (official docs, checked before coding and cross-checked against installed `sdk.d.ts`): [query/types](https://code.claude.com/docs/en/agent-sdk/typescript), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [skills/settingSources](https://code.claude.com/docs/en/agent-sdk/skills).
