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
