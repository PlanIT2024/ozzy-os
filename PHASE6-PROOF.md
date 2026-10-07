# Phase 6 — step-approved Wayland control

Branch `phase6-control`, based on main `93e2753`. Final validation/deployment:
2026-10-07. Live consent and Stop proof: 2026-10-06.

## Implementation and research

Linux uses the RemoteDesktop portal with ScreenCast monitor selection. Absolute
pointer input targets the selected stream with its logical position/size. No
PipeWire video connection is opened and no recording is made. At one approved
action per second, the supported D-Bus Notify methods avoid a libei native
binding. EIS is supported/recommended upstream for higher-volume input, but is
not required here; the two input paths are never mixed.

Matching references checked:

- [RemoteDesktop API](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html): Notify methods, ConnectToEIS, device selection and single-use restore tokens.
- [Portal 1.21.1 implementation](https://github.com/flatpak/xdg-desktop-portal/blob/1.21.1/src/remote-desktop.c).
- [GNOME portal 50.0 implementation](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/remotedesktop.c): persisted device/monitor consent.
- [GNOME stream metadata](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/50.0/src/gnomescreencast.c): compositor position and size.
- [GNOME Shell 50.1 indicator/Stop](https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/status/remoteAccess.js) and [Mutter session teardown](https://github.com/GNOME/mutter/blob/50.0/src/backends/meta-remote-desktop-session.c).
- [Host Registry](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html): the helper registers `com.ozzy.bit-node` before portal calls, matching the installed desktop file rather than relying on the `bit-node.service` cgroup name.

Installed Agent SDK **0.3.284** public types expose MCP `tool()` handlers returning
`CallToolResult` image blocks (`type: image`, `data`, `mimeType`), and `tools` is
built-in names/preset configuration. They do not expose a native Anthropic
computer-use definition with display geometry. A custom `computer` MCP tool
therefore implements screenshot, mouse_move, left_click, right_click,
double_click, drag, scroll, key and type. Every call needs the owner button;
every input returns a fresh verification screenshot. Control runs retain the
Phase 5 non-persistent SDK/image-cache settings and text-only context bridge.

## Safety and state

Node input is disabled by default. Advertising requires CONTROL_ENABLED=true,
an available screen, an unlocked Wayland session and reachable portals. Darwin
and Windows report not supported yet. The node independently validates actions,
blocks Ctrl+Alt+Delete and Ctrl+Alt+F1–F12, allows Super+L, limits type to 500
Unicode characters, enforces a global one-action-per-second limit and persists
counts, expiry and cap before execution. Reopening cannot extend a grant's
node-owned expiry or reset its cap/rate limit. Coordinates are mapped from scaled
screenshots into logical monitor space, including negative origins, scaling,
two monitors and gaps. Current geometry and selected-stream geometry must match.
A screenshot older than two minutes is refused.

Held keys/buttons are released after actions and on errors, cancel, Stop,
expiry and disconnect. Portal closure ends the runtime immediately and sends an
authenticated application event to the brain. Storage failures still tear down
input and disable capability. Raw-FD IPC avoids Python read-ahead hiding queued
release requests. Logs contain action names, coordinates, keys, text length,
portal stages/codes, exposed D-Bus errors and helper exit status. Text is logged
only with CONTROL_LOG_TEXT=true. No image content or restore tokens are logged.

Owner-only /control on|off|status|preview commands are registered. On requires an
existing same-thread/machine screen grant; only explicit with-screen:true starts
one automatically. Grants are limited to ten minutes and BIT_CONTROL_MAX_ACTIONS
(default 40), with shorter existing screen expiry respected. Tainted and
scheduled runs, wrong/expired/missing grants and unavailable input are hard
denials. Web results end control. /screen off and /reset also end control.

Only one control step may be outstanding. Approval binds the normalized action,
exact text and observed frame; SDK argument reordering cannot trigger duplicate
cards. Chat and other users cannot approve. Denial ends the task. Optional crops
are at most 160×120, made in memory and attached only to the approval card.
Old-task cleanup cannot revoke a newer owner's grant. Completed and unverified
input attempts are distinguished in end summaries.

Brain grant state is in data/controls.json; node reservations in
data/node-control.json. Both are ignored by git. Shutdown/disconnect closes the
runtime while preserving valid grant limits for later button-approved reopening;
reopening sends no input and returns a fresh screenshot for another approval.
GNOME Stop revokes the grant. A restore token alone never authorizes a brain action.
Persona/system guidance forbids credentials, login/2FA/payment interactions,
security changes and operating bIT's own approval/grant UI.

## Live proof

The owner was notified before each real test. All tests ran in transient user
systemd services, using the graphical manager environment, not a shell-only
capture context.

- Oct 6, 15:47:40 EDT: bit-control-consent.service opened the focused bIT window
  and GNOME consent. CreateSession, SelectDevices, SelectSources and Start each
  returned **0**. Registered sender `:1.1300`, app ID `com.ozzy.bit-node`.
  Keyboard and pointer were both granted; Start returned a restore token and
  monitor stream 79, position [0,0], size [1920,1080]. No input was sent in this
  first test. Automatic cleanup closed it after its two-minute Stop wait.
- A second consent-only session restored successfully without another prompt;
  it also closed automatically. The first Stop wait was not falsely recorded
  as a user Stop.
- Oct 6, 16:14:53 EDT: bit-control-stop-proof-2.service restored consent,
  registered sender `:1.1471`, and again received Start response **0**.
  Read-only accessibility inspection confirmed the exact GNOME **Stop Screen
  Sharing** control was **visible/showing**, rect [1754,0,62,32]. After telling
  the owner, the diagnostic performed one cleanup-only left click at its center
  [1785,16] through RemoteDesktop. It received the portal **Closed** signal:
  `CONTROL_PROOF {"indicatorVisible":true,"portalStopObserved":true}`.
  No typing or other application interaction was performed. Cleanup exited 0.

The earlier read-only indicator check failed to resolve geometry and safely
closed without clicking. The corrected check above is the successful proof.
The benign extra Close on an already-closed session was subsequently removed.

All diagnostic sessions/helpers are closed. Only the stored restore token
remains in data/control-restore.json, verified mode **0600**; no token value was
printed. No test screenshots were taken for this consent/Stop proof.

## Validation and deployment

**/usr/bin/node --test: 108 passed, 0 failed**, including all existing tests.
Coverage includes hard denials; exact typed text on cards; owner/button-only
approval; denial ending a task; one outstanding step; SDK argument ordering;
post-action verification images; cap/rate and restart persistence; global rate
limits across grants; expiry and changed grants; two-monitor/scaling/gap mapping;
node blocklists; release on error/disconnect/Stop; disabled capability; encrypted
capability changes/closure delivery; cropped previews; storage-failure teardown;
batched helper release/EOF; suspension versus revocation; and stale-task cleanup.

The real installed SDK test uses a local fake API and synthetic image. It
asserts three approvals for three computer calls, one input request, three
screenshots, conversation continuity and resumption. Recursive workspace scans
including SDK session files reject pixel base64, image files/magic bytes and the
fixture's typed tool text. Live typing, dragging, scrolling and a real second
monitor were not exercised; those paths have mocked validation/portal tests.

/control was registered with /usr/bin/node src/brain/discord.js --register.
Final /usr/bin/node scripts/services.js install succeeded Oct 7 at
09:01:09 EDT (13:01:09 UTC). Both units are active/running on /usr/bin/node
**v22.23.3**: brain PID 240097, node PID 240098. Node authenticated at 09:01:11;
Discord connected as bIT Agent#6243 at 09:01:13.

**CONTROL_ENABLED=false** is left in actual .env and .env.example. The final
brain journal confirms authenticated capabilities **status, screen**, with no
input capability. The /machines renderer uses these same capabilities and adds
input only when advertised. Actual SCREEN_ENABLED=true was preserved; the
example keeps its existing false default. Transport, relay and crypto code were
not changed. Web URL/approval policy was not changed; its taint now revokes control.
