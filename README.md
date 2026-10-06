# OZZY OS · bIT — Phase 2

OZZY-AI is the permanent brain. Discord remains owner-only; nodes expose **status only**. A remote node and the brain each connect outbound to a blind relay. OZZY-AI listens only on loopback; no public listener, inbound firewall exception, or port forwarding is needed. This repository is independent of PlanIT.

## Install/upgrade on OZZY-AI

Use Node.js LTS (22 or newer) and Git. This release was tested on Node 22.23.1. Keep the checkout at `~/ozzy-os` for the user service units.

```sh
cd ~/ozzy-os
npm ci
# For a fresh install only:
cp .env.example .env
chmod 600 .env
npm run --silent keygen -- --role brain
npm run --silent keygen -- --role node
```

**Do not overwrite an existing `.env`.** Each keygen invocation prints only the public key; it preserves an existing keypair. Brain/node keys are separate roles on OZZY-AI, stored under `data/keys/brain.json` and `node.json`. Files are created with mode 0600 and their directory with 0700. `data/` is gitignored. On Windows, also keep the checkout in the user's private profile with restrictive NTFS ACLs; POSIX modes do not enforce Windows ACLs.

Fill the existing Discord/API configuration (`ANTHROPIC_API_KEY`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `BIT_CHANNEL_ID`, `OWNER_DISCORD_ID`). The model defaults to `claude-sonnet-5`; change `BIT_MODEL` if your account uses another available model. Enable Message Content Intent for the Discord bot and grant View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History and Attach Files. Register the guild slash commands once with `npm run register-commands`.

Pair the local node in `.env`:

```dotenv
MACHINE_NAME=OZZY-AI
NODE_TRANSPORT=local
BRAIN_URL=ws://127.0.0.1:8787
NODE_HUB_BIND=127.0.0.1
NODE_HUB_PORT=8787
NODE_TOKEN=<random-local-token>
NODE_TOKENS=OZZY-AI:<same-random-local-token>
BRAIN_PUBLIC_KEY=<brain-public-key>
NODE_KEYS=OZZY-AI:<node-public-key>
AUTO_PUSH=false
```

Generate the local random token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keys are 64 hex characters. Tokens and keys serve different purposes: local/relay tokens gate transport access; only E2E keys authenticate application traffic. `NODE_KEYS` may contain comma-separated `name:publickey` entries. Names match case-insensitively but display as sent by the authenticated machine. The reserved name `brain` cannot be a node.

## Always-on Linux services

The following **manual sudo step is required once** for reboot/logout operation:

```sh
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

It must report `Linger=yes`. Linger was already enabled on OZZY-AI during verification. Then:

```sh
npm run service:install
npm run service:status
npm run service:logs
```

Installation copies `deploy/systemd/bit-{brain,node}.service` into the user unit directory, substitutes the current absolute Node executable, reloads systemd, and enables/starts both units. Both use `WorkingDirectory=%h/ozzy-os`, `EnvironmentFile=%h/ozzy-os/.env`, `Restart=on-failure`, `RestartSec=5`, a limit of five starts per 120 seconds, and `UMask=0077`. The local node Wants/After the brain. They run independently of terminals. Updating unit files requires rerunning install; after changing code or `.env`, run:

```sh
systemctl --user restart bit-brain bit-node
```

`npm run service:uninstall` stops/disables/removes the user units without deleting `.env`, keys, data, or memory. For a node-only Linux machine, use `npm run service:install -- --node-only` (and the same flag with status/logs/uninstall); its unit has no brain dependency.

Only one brain may own `data/brain.lock`. A confirmed dead PID is reclaimed; live, inaccessible or malformed PIDs are protected. SIGINT/SIGTERM clean up the lock. A crash including SIGKILL is recovered by the next start. To deliberately test recovery:

```sh
systemctl --user kill --signal=KILL --kill-whom=main bit-brain.service
# Wait at least five seconds, then:
systemctl --user show bit-brain -p MainPID -p NRestarts
```

If a configuration problem exhausts the start limit, fix it then `systemctl --user reset-failed bit-brain bit-node` and restart. Authentication rejections print a clear reason and stop the node process; systemd's bounded restart policy may retry it. No silent endless authentication retry occurs inside the node.

## Relay and adding a machine

Prepare/deploy the standalone `relay/` service yourself using [relay/README.md](relay/README.md). Railway root directory is `/relay`; the Dockerfile and independent lockfile are included. **Nothing was deployed to Railway.** Only the Railway relay binds publicly. OZZY-AI rejects non-loopback hub bind addresses.

For each remote machine:

1. Clone this repo (the Phase 2 branch until it is merged), run `npm ci`, then `npm run --silent keygen -- --role node`.
2. Transfer only that public key to OZZY-AI over a trusted channel. Add `MACHINE-NAME:<node-public-key>` to the brain's `NODE_KEYS`. Verify the brain public key on the node by the same trusted channel. Do not accept keys from the relay or automatically trust first connections.
3. Generate a distinct relay token with `node relay/token.js`. Add its SHA-256 hash, client name and `role: "node"` to the relay's `RELAY_CLIENTS`; give the raw token only to the node. Configure the single `brain` relay client similarly.
4. Create this **node-only** `.env` on the remote machine:

```dotenv
NODE_TRANSPORT=relay
RELAY_URL=wss://<relay-domain>/
RELAY_TOKEN=<this-node-token>
BRAIN_PUBLIC_KEY=<verified-brain-public-key>
MACHINE_NAME=MACBOOK
```

No Discord/API credentials or local `NODE_TOKEN` are needed there. Optional `NODE_KEY_FILE` selects a different private key file. Brain key override is `BRAIN_KEY_FILE`. The keygen equivalent override is `BIT_KEY_FILE`; otherwise the standard role paths are used.

On OZZY-AI set `RELAY_URL=wss://<relay-domain>/` and `BRAIN_RELAY_TOKEN=<brain-relay-token>` while keeping `NODE_TRANSPORT=local` for its own local node. The brain runs the local listener and outbound relay connection together. A node-only machine uses `RELAY_TOKEN`; `NODE_RELAY_TOKEN` is an optional override if sharing an env with a relay-connected brain. Restart the relay after updating token hashes, restart the brain after updating `NODE_KEYS`, and start the new node with `npm run node` or its user service. `/machines` shows it online after the E2E handshake and hello.

Rotate/revoke transport tokens on the relay and restart it. To revoke a node identity, remove its `NODE_KEYS` entry and restart the brain. Changing E2E keys requires re-pairing both public-key configurations. Do not share a private key between different machine names.

## macOS and Windows node startup

**macOS:** `npm run service:install` installs `~/Library/LaunchAgents/com.ozzy.bit-node.plist`, substituting absolute paths and enabling the node in the logged-in GUI session. The template is in `deploy/launchd/`. `.env` is loaded by the application. `service:status`, `service:logs` and `service:uninstall` support Darwin. LaunchAgent logs are `data/node.log` and `data/node-error.log`. This intentionally runs with your desktop login, not as a root daemon.

**Windows:** create a Task Scheduler task named `bIT Node`:

- Trigger: **At log on**, for your user; choose **Run only when user is logged on**.
- Program: the absolute path to `node.exe` (find it with `where node`).
- Arguments: `"C:\Users\<you>\ozzy-os\src\node\index.js"`.
- Start in: `C:\Users\<you>\ozzy-os`.
- Settings: restart on failure every minute, up to three attempts; do not start another instance; remove the automatic time limit. Disable “start only on AC power” if you want laptop status on battery.

Run the task once and confirm `/machines`. To remove it, end/disable/delete the task. It is deliberately **not** a Windows service, preserving the interactive session for future screen/input work. macOS and Windows installation templates/instructions were not executed on this Linux host.

## Encryption and transport

Both transports use the identical libsodium protocol: `crypto_kx` X25519 key agreement gives separate brain→node and node→brain keys; XChaCha20-Poly1305 encrypts every handshake and application payload with a fresh random 24-byte nonce. Authenticated data binds protocol version, sender, recipient, message ID, session identifier and a per-direction 64-bit monotonic counter. Receivers reject counters no newer than the last authenticated one, wrong session/name/key, and failed authentication. Failed ciphertext never advances the accepted counter.

An encrypted node nonce, encrypted fresh brain challenge, and encrypted finish proof establish a new random session before the node is registered online. Counter resets are confined to that session: captured traffic from before reconnect/restart cannot authenticate to the new challenge. Long-term static key agreement does not provide forward secrecy if an endpoint's private key is later stolen; protect and rotate key files. The relay has neither key and cannot impersonate a trusted node with only a relay token. It can still deny service and observe routing names, IDs, sizes and timing.

Application envelopes remain `req`/`res` with ID, method and params/result, so future capabilities can extend dispatch without changing the relay. Only `status` is implemented; no screen/input/camera/shell placeholders are added. Requests time out at 10 seconds, status heartbeat is every 30 seconds, nodes expire after 90 seconds, and network failures reconnect with backoff. `ws://` is accepted only for loopback relay tests; remote connections require `wss://`.

References: [libsodium key exchange](https://libsodium.gitbook.io/doc/key_exchange), [XChaCha20-Poly1305](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction).

## Discord, memory, skills and growth commits

Only the owner is handled in #bit, its threads and DMs. Top-level #bit messages create separate threads/sessions; thread replies resume them. Guild slash commands are `/machines`, `/mood`, `/budget`, `/schedule`, `/reset`. `/machines` shows one line per node, such as `OZZY-AI 🟢 up 3d · CPU 8% · RAM 6/50 GB · disk 6%`; offline nodes show last-seen time (or never). Last-seen registry timestamps are in-memory and reset on brain restart. The model's tools still receive structured status. Pseudo mounts, efivars, `/boot/efi`, tmpfs and snap loops are excluded.

Personality defaults to chill, with saved chill/hype/chaotic/gremlin/sage choices and sage from 22:00–04:59 in `TZ`. Owner memory lives in `bit/memory`; successful writes post `📝 noted`. Persona is read-only. Source, `.env`, `data/keys`, home Claude configuration and other paths are denied to model tools. Read/Write/Edit/Glob/Grep/Skill, WebSearch/WebFetch, the two status tools and the reminder tools are exposed. The Phase 3 web policy still governs web calls and tainted memory writes. Permission callbacks and pre-tool hooks enforce the path policy. No Bash tool is available; host-controlled Git operations below are separate from the model's tool surface.

Skills load only from `bit/skills` through the verified project discovery alias and explicit allowlist. Bundled/user/synced skills are disabled. Skills require matching folder/name and descriptive YAML metadata; no shell preprocessing, hooks or subagents. Every skill write/edit needs the owner's Discord ✅ button. Chat text cannot authorize it. A minimal unified diff with three context lines is shown inline when short and attached in full; ❌, cancellation and ten-minute expiry deny it.

After each successful approved skill write, the host stages **only that skill folder**, commits `bIT: add skill <name>` or `bIT: update skill <name>`, and posts a one-line note in #bit. Multi-file skills may produce multiple commits as each approved write completes. Memory changes are collected at most once per hour into `bIT: memory notes <UTC-date>`, with the last batch time persisted across restarts. Existing/manual changes within an included folder join its next batch; review personal memory before enabling remote pushes.

Growth commits use `git commit --only -- <allowed-folder>` so unrelated changes already staged in your index do not enter the commit. Only `bit/memory/**`, `bit/skills/<name>/**` and individual approved `bit/schedules/<name>.md` files are staged; symlinks and nested repositories are rejected. Configure local `git user.name` and `git user.email` if missing. Repository Git hooks are disabled for automatic commits. No automatic push occurs unless `AUTO_PUSH=true`; Git/push failures are logged to console and `data/audit.log` without crashing the brain. Auto-push requires a configured upstream and suitable Git credentials; push errors do not undo local commits.

## Schedules and reminders

The brain reads `bit/schedules/<name>.md`. Each file has YAML frontmatter with
`name` (matching its filename), a quoted five-field `cron`, `enabled: true|false`,
and `channel: bit`, followed by the job instructions. Every schedule write/edit
needs the owner's ✅ button; approved changes commit as `bIT: add|update schedule
<name>`. Prefer Edit for existing files. The seeded jobs are `daily-brief` at 08:00
weekdays and `weekly-review` at 18:00 Sundays, in `.env`'s `TZ`.

Use `/schedule list`, `/schedule pause name:<name>`, `/schedule resume name:<name>`
and `/schedule run name:<name>`. Pause/resume live only in `data/scheduler.json`;
resuming a file with `enabled: false` requires an approved file edit first.
Paused/disabled jobs cannot run manually. Each run creates a dated thread in
#bit, checks budget and starts a fresh untainted SDK session. Web tools are off
unless a line in the approved body explicitly says `Use WebSearch ...` or
`Use WebFetch ...` (also `Call`/`Invoke`). Then the existing web rules and taint
tracking apply. A skill mentioning web access does not enable it for a job.

Startup catches up the latest missed occurrence within two hours. Older missed
runs are skipped and mentioned in the next brief; pause time does not accumulate
catch-ups. Claims are saved before running so an interrupted job is never
replayed. Repeated fall-back wall-clock slots run once, at the first occurrence;
a nonexistent spring-forward cron time follows cron-parser's DST shift behavior.
Manual runs are explicit additional runs and do not consume a future cron slot.

Ask bIT “remind me in 20 minutes to stretch” or “remind me tomorrow at 3pm to call”.
`set_reminder(when, text)` resolves in `TZ`, returns the exact local timestamp and
id, and sends ⏰. `list_reminders()` and `cancel_reminder(id)` manage pending
reminders in gitignored `data/reminders.json`. Setting one after web results
requires ✅, showing the exact resolved time and text. Ambiguous fall-back times
need an explicit ISO offset; nonexistent local times are rejected.

Reminders mention only the owner. They go to the original #bit thread (unarchived
if needed), or #bit if the original is gone/inaccessible or was a DM. Overdue
reminders are sent on startup, marked late. Delivery claims survive crashes;
recovery checks the destination's message history for the reminder id before
retrying, and also uses Discord nonce deduplication. Network failures retain the
claim and retry with backoff. If history cannot be checked safely, the claim stays
visible in `list_reminders()` rather than risking a duplicate mention. This relies
on bot message-history access; deleting a delivered message before reconciliation
can remove the evidence used for deduplication.

## Budget, diagnostics and validation

Monthly cost comes from SDK result messages. Runs serialize; cumulative resumed-session costs are charged only once. `BIT_MONTHLY_CAP_USD` gates new calls and sets the SDK's remaining-run budget. An in-flight response can exceed the cap. Unknown spend after an interrupted API run fails closed; reconcile `data/budget.json` before clearing its `uncertain` flag. `TZ` defines month boundaries. Machine status and slash commands need no API spend.

Discord logs its ready tag and incoming filter decisions. Login/fatal gateway errors log full diagnostics and exit nonzero; disallowed intents include a Developer Portal hint. Node authentication rejections explain which pairing/token settings to inspect. Relay logs never include payloads. `data/` contains personal transcripts, audit/budget/session state and keys; keep it private and backed up. `.env` and all runtime data are gitignored. Memory, skills and schedules themselves are tracked growth artifacts.

Run `npm test` for the complete suite. [PHASE4-PROOF.md](PHASE4-PROOF.md) records scheduling/reminder validation and the live brief. [PHASE2-PROOF.md](PHASE2-PROOF.md) records tests, service/relay proofs, and remaining manual checks. [PROOF.md](PROOF.md) preserves Phase 1 history.
