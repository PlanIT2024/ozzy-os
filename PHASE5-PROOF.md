# Phase 5 proof — 2026-10-06

Branch `phase5-screen` from main (`5f59829`). Final state: `SCREEN_ENABLED=false`.
No real desktop capture or consent prompt was requested during this work.

## Implementation

- Platform-neutral `src/node/screen` available/capture/close interface, Linux
  Screenshot portal implementation, unsupported Darwin/Windows stubs.
- Enabled-node availability checks each 15 seconds: current manager/session env,
  live Wayland socket, Screenshot portal, unlocked GNOME session, monitor layout.
  Status-only before graphical login/after logout or loss; authenticated dynamic
  capability updates. Disabled nodes never probe/capture through this interface.
- Existing authenticated req/res application protocol adds only `screen` and
  capability updates. No changes to relay/wire, crypto or transport modules.
- GNOME's URI PNG is opened, ownership/type checked, unlinked before reading,
  and its fd closed in finally. No bIT image files. libvips is initialized with a
  1 GiB disk threshold (above the bounded input raster) and no open-file cache.
  Memory-only Sharp resizing,
  long edge at most 1568, JPEG quality 80 or PNG if smaller, at most 2 MiB.
- Original/scaled dimensions, UTC capture timestamp and logical monitor layout.
  Notification per capture via portal AddNotification, notify-send fallback.
- Owner /screen on/off/status: 15-minute per-conversation/per-machine persisted
  grants. /reset revokes. Scheduled jobs cannot capture. Expired/revoked grants,
  offline/no-capability machines and daily cap deny before node requests.
- Tainted sessions require a Screenshot ✅ card for each capture (machine/time),
  recheck the grant after approval, and reauthorize if taint arrives after the
  original permission check. Chat cannot approve. Approval UUID is audited.
- SDK custom-tool image result verified from installed SDK tool handler's
  `Promise<CallToolResult>` and MCP ImageContentSchema: `{type:'image',
  data:<base64>, mimeType:'image/png'|'image/jpeg'}`.
- Screenshot-enabled turns set SDK `persistSession:false` and
  CLAUDE_CODE_SKIP_PROMPT_HISTORY=1. Installed CLI source's MCP image path skips
  file caching when persistence/history is off. Ephemeral ids are never saved
  as resumed sessions. Existing thread taint is preserved.
- Metadata-only capture audits; reserved daily attempts in `data/screens.json`,
  default cap 40; /budget count. 📸 notice after each successful look. One scaled
  Discord image only for an explicit attachment request in the actual owner
  message; quoted/page instructions are not treated as attachment requests.

## Installed system and consent research

Ubuntu 26.04.1, GNOME Shell 50.1-0ubuntu1.3,
xdg-desktop-portal 1.21.1+ds-1ubuntu3.1,
xdg-desktop-portal-gnome 50.0-0ubuntu1, Python GI 3.56.2-1.
Sharp 0.35.5 installed, npm reported zero vulnerabilities.

The services installer adds the hidden desktop identity `com.ozzy.bit-node`
(display name bIT). Registry registration was verified by the real read-only
probe. Host Registry reference:
https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html

Consent inference from matching-version primary sources:

- Front portal 1.21.1 remembers Allow/Deny for non-interactive Screenshot;
  ask-mode prompts each time. Named app identity avoids the unnamed-app group.
  https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/screenshot.c
- GNOME 50.0 skips the share/preview dialog when permission_store_checked is true.
  https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/screenshotdialog.c

Thus Screenshot supports unattended calls after initial Allow on this version;
ScreenCast fallback is not selected. README describes expected consent frequency
and privacy-settings revocation. Actual consent UI is pending the owner's live
check, because SCREEN_ENABLED remains false. No private GNOME capture bypass,
X11 fallback, RemoteDesktop or input control is implemented.

## Automated validation

`/usr/bin/node --test`: **84 passed, 0 failed**, all existing tests included.
`git diff --check` passed. Tests ran outside the restricted sandbox for local
sockets, SDK subprocesses and temporary Git repositories.

Coverage: disabled gate and unsupported platforms; size/aspect/encoding/cap;
missing, expired, wrong-thread and wrong-machine grants; scheduled denial;
button-only tainted screenshot; taint between authorization and execution;
revocation while approval is pending; grant/day-count persistence and rollover;
reset/off; true MCP image result; no audit/file pixel retention; attachment
opt-in and once per run; capability appearance/disappearance; bounded encrypted
capture over real node/hub; owner-only commands; machines/budget; portal-file
unlink success/oversize failure; portal notification API; SDK persistence flags.

A separate test ran the **real installed Agent SDK** with a synthetic image and
local fake Messages API. The fake API received actual image content. The test
scanned its entire temporary SDK/workspace tree for base64 pixels, image file
extensions and PNG/JPEG signatures and found none. It also confirmed no resumable
image-session id was saved. No external model API or real desktop was used.

## Disabled live proof

Reinstalled services using `/usr/bin/node scripts/services.js install` (including
the desktop identity). Registered the real guild command set:
`mood, machines, budget, screen, schedule, reset`.

Temporarily stopped the brain to avoid duplicate hub/ledger writers. A proof
process used the real authenticated NodeHub and Discord client. The actual node
advertised:

```json
{"machine":"OZZY-AI","online":true,"capabilities":["status"]}
```

The same `/machines` owner-command handler was exercised using a local interaction
envelope; the acknowledgement was captured locally (not a fabricated Discord
event). It produced:

```text
OZZY-AI 🟢 up 4d · CPU 5% · RAM 4/49 GB · disk 7%
```

No screen capability appeared. No screenshots were requested. A direct read-only
portal Registry/Properties/Mutter probe reported:

```json
{"available":true,"portalVersion":2,"monitors":[{"connector":"DP-2","x":0,"y":0,"width":1920,"height":1080,"scale":1,"primary":true,"coordinateSpace":"logical"}]}
```

This probe checks availability only, not Screenshot.Screenshot or permissions.
The proof process cleaned up the hub/lock, then reinstalled/restarted both services.
Final verification after the 13:42:08 EDT reinstall:

```text
bit-brain: ActiveState=active SubState=running MainPID=165516
bit-node:  ActiveState=active SubState=running MainPID=165517
both: ExecStart path=/usr/bin/node
.env: SCREEN_ENABLED=false
.env.example: SCREEN_ENABLED=false
```

Journal confirmed Discord connected, brain awake, and OZZY-AI authenticated online
at 13:42:10 EDT. The node recovered from its initial ECONNREFUSED on attempt 2.
The final suite additionally verifies fresh-process native image-loader cache
settings and omission of unexpected pixel-bearing screenshot input fields from
both decision and failure audits.

## Limits and owner live check

GNOME creates its screenshot URI file briefly; normal and oversize cleanup are
verified. A process/power failure before the URI can be consumed can leave that
GNOME file. Notifications are submitted each capture; GNOME DND/banner settings
control visual display. An in-flight capture can finish after /screen off, but
its image is discarded if the grant is no longer valid. Screenshot turns do not
retain image conversation history.

Owner will enable SCREEN_ENABLED=true and restart the node, then in a #bit thread
use `/screen on`, ask “what's on my screen?”, check the desktop notification and
📸 thread notice, and use `/screen off`. Default replies must contain no image
attachment. To test an attachment explicitly, ask “Please attach the screenshot.”
Live desktop capture, consent frequency and notification appearance remain pending.
SCREEN_ENABLED=false is left in both actual .env and .env.example.

## Phase 5 fixes — 2026-10-06

Branch: `phase5-fixes`, based on main (`476edc5`).

Conversation continuity now uses brain-owned text-only JSON files in
`data/thread-transcripts/` (hashed thread filenames, mode 0600, ignored by git).
The store contains owner messages, bIT replies and screenshot metadata plus a
bounded reply-description placeholder. It never receives SDK image/tool-result
blocks. Text serialization removes image data URIs and long encoded blobs.
Recent turns are limited to 24 / 48,000 serialized characters; older turns are
condensed into an extractive summary capped at 12,000 characters. Individual
turns are capped at 12,000 characters. This summarization is intentionally lossy.

Every run receives the capped text history. Screenshot-enabled turns remain
`persistSession:false` with `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, without resuming
or saving their ephemeral SDK IDs. Normal runs resume their original SDK session
and receive the text bridge, including intervening screenshot descriptions.
Existing threads bootstrap conversational text from their prior SDK JSONL,
excluding image blocks, tool results and sidechains. Turning a grant on/off
leaves the text history unchanged; `/reset` clears it. Images are not retained
for follow-up questions: bIT has the description and must recapture to inspect
pixels again.

When an online machine advertises screen capture, the system prompt tells bIT
that screenshots are available and that `/screen on` enables them for 15 minutes
in this thread. The screenshot MCP server remains absent without an active
grant; scheduled runs still cannot use it.

Validation: `npm test` — **86 passed, 0 failed**, including all existing tests.
The real installed Agent SDK test uses a local fake API and synthetic image:
first owner message → persistent session → simulate upgrade by removing the
brain transcript → grant on → screenshot → another screen run → grant off →
normal resumed run. Assertions inspect actual main model API requests for the
first message and the screenshot description after grant off. Recursive scans
of the test workspace, including SDK session files and the brain transcript,
reject image base64, image files and PNG/JPEG magic bytes. Additional regressions
cover grant-on history invariance, brain restart, reset, bounded summaries,
legacy import filtering and no-grant guidance/tool absence. No live desktop
capture or owner Discord conversation was performed for this fix.

Deployment: `/usr/bin/node scripts/services.js install` succeeded at
2026-10-06 18:23:56 UTC. `systemctl --user show` verified both services
`active/running`, with ExecStart `/usr/bin/node`:

- brain PID 173110; Discord connected as bIT Agent#6243 at 18:23:58 UTC.
- node PID 173111; connected and authenticated online at 18:23:59 UTC.

The node's initial ECONNREFUSED during the restart recovered on its second
attempt. No `.env` setting, transport, relay, crypto or web policy was changed.

## Live screenshot failure fix — 2026-10-06

Root cause: GNOME refused the first screenshot permission dialog because the
background bIT process was not the focused application. The environment and
app identity were valid. At 14:29:50 EDT the front portal logged:
`org.freedesktop.DBus.Error.AccessDenied: Only the focused app is allowed to show a system access dialog`.
The portal converted that backend D-Bus failure into Screenshot response **2**,
which the node previously swallowed behind a generic error with no diagnostics.

Versions checked on the machine: xdg-desktop-portal `1.21.1+ds-1ubuntu3.1`,
GNOME portal `50.0-0ubuntu1`, GNOME Shell `50.1-0ubuntu1.3`.
Matching authoritative implementation references:

- [Portal 1.21.1 screenshot permission/response path](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/screenshot.c): non-interactive first requests invoke AccessDialog; failure returns response 2.
- [GNOME Shell 50.1 focus check](https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/accessDialog.js): compares the requesting app's desktop ID with the focused app.
- [Portal 1.21.1 cgroup ID detection](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/xdp-app-info-host.c): `bit-node.service` alone does not match the `app-` unit convention.
- [Portal 1.21.1 host Registry](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/registry.c) and [supported Registry API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html): explicitly registers the sender as `com.ozzy.bit-node`, overriding cgroup detection. The existing desktop file matches; changing the unit name is unnecessary.

Fix: for unset/ask permission, present a GTK 4 Wayland window with bIT's registered
application ID. Owner clicks Continue to focus bIT, then GNOME presents its own
Allow/Deny dialog. bIT reads permission state but never changes it directly.
Stored Allow uses the existing non-interactive Screenshot API with no extra
window; stored Deny remains denied. All consent/request waiting shares a
110-second deadline. An image returned after consent expiry is consumed/deleted
and discarded. No ScreenCast fallback or input-control API was added.

Logging: every node screen request logs the attempt and any availability/busy/
capture failure. Linux diagnostics log stages, permission state, registered
identity, portal response code, exposed D-Bus error name/message, structured
helper stderr, helper exit status/signal, deletion and output dimensions/time.
The helper's image-bearing stdout, arbitrary exception text and unstructured
stderr never enter logs. Messages redact file/data URIs and encoded blobs.
Backend errors wrapped by the front portal as response 2 can expose their
D-Bus details only in the portal journal; correlate request timestamps.

Real service-context evidence (EDT, UTC = EDT + 4 hours):

1. 14:33:55: `systemd-run --user --wait --pipe --collect` with the original
   non-interactive path reproduced response **2** in 109 ms. The session was
   unlocked, Screenshot version 2 and DP-2 monitor layout were reachable;
   portal journal repeated the focused-app AccessDenied error.
2. 14:34:55: corrected capture from `bit-screen-live.service` succeeded with
   response **0** after first consent. Metadata-only D-Bus monitoring observed
   the GNOME backend receive `com.ozzy.bit-node` and the dialog title
   “Allow bIT to Take Screenshots?”. Owner was told before capture.
3. 14:35:48: `bit-screen-repeat.service` reused permission **yes**, response
   **0**, with no consent window; helper process exited successfully.
4. 14:38:58: temporary `ExecStartPost` inside **bit-node.service itself** ran
   the same LinuxScreen capture. Journal records sender `:1.988` registered
   as `com.ozzy.bit-node`, permission **yes**, response **0**, helper exit **0**.
   The temporary runtime drop-in was removed in a finally block and manager
   reloaded; `ExecStartPost` is empty again. No permanent unit override remains.

Each successful test capture returned 1920×1080, scaled to 1568×882, requested
“bIT took a screenshot” notification, unlinked the portal PNG immediately, and
discarded image bytes. No test image was retained or printed. The first capture
can contain bIT's consent helper window; subsequent captures have no such window.

Locked-session behavior: availability and capture check GNOME ScreenSaver state
before issuing Screenshot and again after consent. Locked means no capture and
no advertised screen capability on the next poll. A mocked locked-session
regression verifies rejection before monitor/capture access. A live lock test
was offered but no lock confirmation was received, so live lock/unlock behavior
was not tested during this run.

Final full suite: **88 passed, 0 failed**. New regressions cover response 0/1/2,
permission routing (yes/no/unset), lock rejection, D-Bus error diagnostics,
stderr/exit logging and exclusion/redaction of image-bearing fields/stdout.
Existing real-SDK image non-persistence test still passes.

Services reinstalled with `/usr/bin/node scripts/services.js install` at
14:38:57 EDT. Both are active/running on `/usr/bin/node`: brain PID 183225,
node PID 183226. Discord connected at 14:38:59 and node authenticated online at
14:39:00. `.env`, screenshot enable flag, transport, relay, crypto, grants and
web policy were unchanged.
