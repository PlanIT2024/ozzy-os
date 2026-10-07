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

Only the owner is handled in #bit, its threads and DMs. Top-level #bit messages create separate threads/sessions; thread replies resume them. Guild slash commands are `/machines`, `/mood`, `/budget`, `/screen`, `/schedule`, `/reset`. `/machines` shows one line per node, such as `OZZY-AI 🟢 up 3d · CPU 8% · RAM 6/50 GB · disk 6%`; offline nodes show last-seen time (or never). Last-seen registry timestamps are in-memory and reset on brain restart. The model's tools still receive structured status. Pseudo mounts, efivars, `/boot/efi`, tmpfs and snap loops are excluded.

Personality defaults to chill, with saved chill/hype/chaotic/gremlin/sage choices and sage from 22:00–04:59 in `TZ`. Owner memory lives in `bit/memory`; successful writes post `📝 noted`. Persona is read-only. Source, `.env`, `data/keys`, home Claude configuration and other paths are denied to model tools. Read/Write/Edit/Glob/Grep/Skill, WebSearch/WebFetch, the two status tools and the reminder tools are exposed. The screenshot MCP tool is exposed only for a non-scheduled turn with an active owner grant. The Phase 3 web policy still governs web calls and tainted memory writes. Permission callbacks and pre-tool hooks enforce the path policy. No Bash tool is available; host-controlled Git operations below are separate from the model's tool surface.

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

## Read-only screenshots (Phase 5)

Screen capture defaults to off. Set `SCREEN_ENABLED=true` on the **node** and
restart it with `systemctl --user restart bit-node.service` when you want to test.
The installation leaves it false. Darwin/Windows implementations currently
report “not supported yet”. No mouse, keyboard, X11 or RemoteDesktop code is used.

In a #bit thread or DM, use `/screen on machine:OZZY-AI` (machine is optional when
only one online node advertises screen), then ask “what's on my screen?”. The
owner-only grant lasts 15 minutes and applies only to that conversation/machine.
`/screen status` shows its expiry; `/screen off` and `/reset` revoke it. Grants
persist in `data/screens.json` and expiry is checked again at capture time.
Scheduled jobs cannot capture. Each screenshot in a tainted conversation also
needs an owner ✅ card showing the machine and time. Chat cannot approve it.

Every successful look posts `📸 looked at <machine>'s screen`. Images stay out of
Discord unless that same owner message explicitly requests an attachment, e.g.
“Please attach the screenshot” or “Can you send me the screenshot?”. One scaled
image is attached per requested run. Image requests inside quoted/page text are
not authorization. bIT describes visible facts and unclear text, and does not
repeat sensitive-looking passwords, tokens, keys or card numbers.

The node rechecks its graphical session/portal every 15 seconds and updates its
advertised capabilities over the existing encrypted application protocol. Before
Wayland login, on logout, when locked, or with a missing portal it exposes only
status. It reads the session variables from `systemctl --user show-environment`
each time, so the lingering service does not depend on its startup environment.
If a custom login setup does not import them automatically, run this **from the
logged-in Wayland desktop**; the next node probe will see the change:

```bash
systemctl --user import-environment WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
```

Linux uses `/usr/bin/python3` with PyGObject/Gio and GTK 4 for first consent and the standard Screenshot
portal. This Ubuntu host already has Python GI 3.56.2, GNOME Shell 50.1,
xdg-desktop-portal 1.21.1 and its GNOME 50.0 backend. A read-only probe confirmed
Screenshot interface version 2, the Wayland portal and monitor layout were
reachable; no real Screenshot request was made during installation.

The installer adds `com.ozzy.bit-node.desktop` (display name **bIT**, hidden from
app menus). The helper registers that identity before portal calls, as required
by the [host Registry API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html).
This avoids unnamed host apps sharing a screenshot permission. With permissions
unset, the matching [portal 1.21.1 source](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/screenshot.c)
shows an “Allow bIT to Take Screenshots?” consent and stores the Allow/Deny choice.
Allow is reused on later requests; an “ask” permission instead prompts each time.
You can change the permission in GNOME privacy settings.

The [GNOME 50 backend](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/screenshotdialog.c)
skips the preview/share dialog once the front portal has checked permission.
**Verified on this installed version:** GNOME Shell 50.1 allows its system
access dialog only when the caller's app is focused. With screenshot permission
unset (or set to ask), bIT first presents its own Wayland GTK window. Click
**Continue**, then **Allow** in “Allow bIT to Take Screenshots?”. The owner click
provides focus; the portal stores permission, and subsequent captures run
unattended without another consent window. Deny is respected; no permission is
written by bIT. The first capture may include the consent helper window.

`bit-node.service` does not follow systemd's `app-<id>.service` naming convention,
so cgroup discovery alone would not identify bIT. The supported Registry call
explicitly associates the helper's D-Bus connection with `com.ozzy.bit-node`,
overriding cgroup discovery; backend method monitoring verified that exact ID.
No service rename is needed. See the matching [Registry implementation](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/registry.c)
and [GNOME focus check](https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/accessDialog.js).

Locked sessions are refused before a screenshot request and are not advertised
as screen-capable; locking is checked again after consent. The consent window
and portal request share a 110-second deadline. Every capture request logs its
stage, response code (0 success / 1 cancelled / 2 other failure), exposed D-Bus
error name/message, structured helper stderr and exit status. Image stdout and
unstructured helper output are excluded. Backend errors converted to response 2
may expose details only in the portal's own journal; correlate its timestamp.
Each capture requests “bIT took a screenshot” through portal notifications,
with notify-send fallback; GNOME's notification/DND settings control banners.
Screenshot was verified to work unattended after first consent, so no ScreenCast
session, continuous stream or restore-token fallback is needed. Denial never
switches to a different capture mechanism.

The [Screenshot API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html)
returns a file URI. For this host app the front portal returns the original GNOME
file. The helper opens it without following symlinks, checks ownership/type,
**unlinks it immediately before reading**, and closes the descriptor in finally.
GNOME briefly creates that portal-owned PNG; bIT creates no image files. A crash
before receiving/opening the URI can leave GNOME's file; normal cleanup and
oversize-failure cleanup are covered by tests. There are no saved bIT captures.

The image loader sets the [libvips disk threshold](https://www.libvips.org/API/8.17/func.get_disc_threshold.html) above the bounded decoded capture size before native initialization and disables its open-file cache.
Sharp downsizes in memory to a 1568-pixel long edge without upscaling, retaining
aspect ratio. It picks the smaller of JPEG quality 80 and PNG, with a 2 MiB limit
that fits the existing 8 MiB encrypted frame limit. The model receives original
and scaled pixel dimensions, logical monitor layout and UTC capture timestamp.
Audits contain metadata/decisions/grant and approval ids, never pixels. Daily
attempts are reserved before capture (failures count conservatively), default
`BIT_DAILY_SCREEN_CAP=40`; `/budget` includes the count.

Screenshot-enabled model turns use fresh **non-persistent SDK sessions** and
skip prompt history, including the SDK's MCP image-file cache. They do not resume
or save image-bearing transcripts. A real SDK test against a local fake API with
a synthetic image verifies no pixel bytes/files are saved. Follow-up screenshots
require another capture. A bounded brain-owned text transcript in
`data/thread-transcripts/` carries owner messages, replies and screenshot
metadata/description placeholders across grant on/off and brain restarts. Older
turns use a capped extractive summary. Screen runs receive this text context;
normal SDK runs also receive it to bridge intervening screen turns. Existing SDK
sessions are bootstrapped from conversational text only. `/reset` clears the
transcript. Without a grant, system context explains `/screen on` while keeping
the screenshot tool hidden. See [PHASE5-PROOF.md](PHASE5-PROOF.md).

## Step-approved computer control (Phase 6)

Input is equivalent to shell access: opening a terminal and typing is possible.
`CONTROL_ENABLED=false` is the default. Linux advertises `input` only with both
that flag enabled and an available, unlocked screen (`SCREEN_ENABLED=true`).
macOS and Windows input backends report “not supported yet”.

Owner commands in a #bit thread or DM:

- `/control on machine:OZZY-AI` requires an existing screen grant for that machine.
- `/control on machine:OZZY-AI with-screen:true` explicitly starts the screen grant too.
- `/control off` closes input immediately; `/screen off` and `/reset` do the same.
- `/control status` shows expiry and used/maximum input steps.
- `/control preview state:on` (or `off`) adds a maximum 160×120 target crop to step cards. Crops are created in memory and attached to Discord only when opted in; no local image files are created.

A grant lasts at most ten minutes, never longer than its screen grant, and uses
`BIT_CONTROL_MAX_ACTIONS=40` by default. Every input action needs Ozzy's ✅ button. Computer screenshots under an active
control grant are automatic and count toward both control and daily screen caps. Chat text cannot approve. Cards show
the node-reported focused app/window, machine, action, intended target in words,
coordinates/keys and the full exact text
for typing. ❌ ends the control task. Web-tainted threads, scheduled jobs, absent/
expired grants and machines without input are hard denials, regardless of approval.
Web results revoke an active control grant. Start with `computer` screenshot;
each input returns another screenshot to verify the result. Screenshot daily
caps still apply and may stop control before its own action cap.

The installed Agent SDK 0.3.284 exposes MCP tools and `CallToolResult` image
content, but no native Anthropic computer-use tool definition/configuration in
its public types. bIT therefore uses a custom `computer` MCP tool with actions
`screenshot`, `mouse_move`, `left_click`, `right_click`, `double_click`, `drag`,
`scroll`, `key`, and `type`. Coordinates refer to the latest scaled screenshot.
The node maps them through the desktop's logical bounding rectangle to each
selected monitor stream; monitor gaps, out-of-bounds targets and changed/unshared
monitor geometry are refused. Scroll can optionally position the pointer first.
Images retain the Phase 5 non-persistent SDK settings and text-only history bridge.

Linux uses [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
with monitor-only [ScreenCast selection](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).
The streams provide logical position/size and the stream ID needed by
`NotifyPointerMotionAbsolute`; bIT never opens or records PipeWire video.
D-Bus `Notify*` input remains supported in GNOME 50. EIS is recommended upstream
for high-volume input; direct D-Bus suits this one-step-per-second interface and
avoids a libei native dependency. The two paths are never mixed.

First control consent uses a focused bIT GTK window, then GNOME's sharing dialog.
Choose the monitors to control and allow restoring consent when offered.
`RemoteDesktop.SelectDevices` uses `persist_mode=2`; the single-use restore token
is replaced after every successful Start and stored mode 0600 in
`data/control-restore.json`, never logged or committed. ScreenCast persistence
options are deliberately omitted for this combined session. Registry registration
uses `com.ozzy.bit-node`, matching the installed desktop file. GNOME's screen-sharing
indicator and Stop control remain active for the portal session; Stop revokes the
brain grant and closes input. Restoring valid consent was tested without another
prompt. Withdrawn permissions or changed monitor selection can prompt again.

Node checks independently block Ctrl+Alt+Delete and Ctrl+Alt+F1–F12, permit
Super+L, limit typed text to 500 Unicode characters, enforce one input action per
second, require a screenshot no older than two minutes and persist session counts
before execution. Keys/buttons are released after actions and on failure, cancel,
Stop, expiry or disconnect. Storage failures disable input and still close the
session. Node-side cap reservations are conservative: failed attempts can count.
`CONTROL_LOG_TEXT=false` logs action kind, coordinates, keys and text length;
only an explicit `true` logs typed text. Portal diagnostics contain stages,
response codes, exposed D-Bus errors and helper exit status; tokens and image
bytes are excluded.

Grant state/expiry/counts live in `data/controls.json`; node reservations in
`data/node-control.json`. Shutdown/disconnect closes runtime portal access.
A persisted valid grant can reopen only after a step's button approval; reopening
returns a fresh screenshot without sending input, so the next action needs a new
approval. At login, 2FA, payment, credentials or security settings, bIT hands back
to Ozzy. He stops when the screen differs from expectations. Start/end messages
and summaries show completed and unverified actions. See [PHASE6-PROOF.md](PHASE6-PROOF.md).

## Budget, diagnostics and validation

Monthly cost comes from SDK result messages. Runs serialize; cumulative resumed-session costs are charged only once. `BIT_MONTHLY_CAP_USD` gates new calls and sets the SDK's remaining-run budget. An in-flight response can exceed the cap. Unknown spend after an interrupted API run fails closed; reconcile `data/budget.json` before clearing its `uncertain` flag. `TZ` defines month boundaries. Machine status and slash commands need no API spend.

Discord logs its ready tag and incoming filter decisions. Login/fatal gateway errors log full diagnostics and exit nonzero; disallowed intents include a Developer Portal hint. Node authentication rejections explain which pairing/token settings to inspect. Relay logs never include payloads. `data/` contains personal transcripts, audit/budget/session state and keys; keep it private and backed up. `.env` and all runtime data are gitignored. Memory, skills and schedules themselves are tracked growth artifacts.

Run `npm test` for the complete suite. [PHASE4-PROOF.md](PHASE4-PROOF.md) records scheduling/reminder validation and the live brief. [PHASE2-PROOF.md](PHASE2-PROOF.md) records tests, service/relay proofs, and remaining manual checks. [PROOF.md](PROOF.md) preserves Phase 1 history.

### Focus safety (Phase 6 fixes)

Before each input card the node reads AT-SPI window metadata (application, active
window title, process ID and accessible window ID). For type/key it checks the
exact snapshot again at execution, including inside the resident portal helper;
a changed focus cancels that step and needs a fresh look and a new approval.
Terminal cards show **⚠️ Typing into a terminal runs commands.** Input cards
display system focus separately from bIT's intended target. No editable contents
are read by the focus query.

`CONTROL_BLOCKED_APPS=discord` is the node default (comma-separated,
case-insensitive app/window matches). All input is denied while a blocked app
is focused, and pointer actions are also denied if their target/destination is
blocked. Missing focus and unknown/ambiguous targets fail closed. AT-SPI uses
[ACTIVE window state](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/enum.StateType.html)
and [screen-coordinate hit testing](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Component.get_accessible_at_point.html).
Wayland does not provide universal stacking information through AT-SPI; overlapping
windows or inaccessible apps can therefore refuse a click. A click is allowed
only inside an unambiguous accessible active window; a lone inactive hit could
be obscured by an inaccessible app. Switch applications with the launcher or
ask Ozzy to focus one manually. Ask Ozzy to focus a
safe app manually if Discord or inaccessible focus blocks the launcher.

After focus-changing clicks bIT must verify the returned focused application
before proposing type/key. Prefer Super, application name, Enter over guessed
dock coordinates. Unexpected results mean stop and report, never repair in a
different app. Each grant posts one warning two minutes before expiry, with its
warning state persisted across restarts.
