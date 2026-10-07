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
double_click, drag, scroll, key and type. Every input needs the owner button;
computer screenshot calls under an active control grant are automatic;
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

**/usr/bin/node --test: 115 passed, 0 failed**, including all existing tests.
Coverage includes hard denials; exact typed text on cards; owner/button-only
approval; denial ending a task; one outstanding step; SDK argument ordering;
post-action verification images; cap/rate and restart persistence; global rate
limits across grants; expiry and changed grants; two-monitor/scaling/gap mapping;
node blocklists; release on error/disconnect/Stop; disabled capability; encrypted
capability changes/closure delivery; cropped previews; storage-failure teardown;
batched helper release/EOF; suspension versus revocation; and stale-task cleanup.

The real installed SDK test uses a local fake API and synthetic image. It
asserts one approval for the typing call and none for the two computer screenshot
calls, one input request, three
screenshots, conversation continuity and resumption. Recursive workspace scans
including SDK session files reject pixel base64, image files/magic bytes and the
fixture's typed tool text. Live typing, dragging, scrolling and a real second
monitor were not exercised; those paths have mocked validation/portal tests.

/control was registered with /usr/bin/node src/brain/discord.js --register.
Final /usr/bin/node scripts/services.js install succeeded Oct 7 at
16:22:56 EDT (20:22:56 UTC). Both units are active/running on /usr/bin/node
**v22.23.3**: brain PID 265348, node PID 265349. Node authenticated at 16:22:58;
Discord connected as bIT Agent#6243 at 16:22:57.

**CONTROL_ENABLED=false** is left in actual .env and .env.example. The final
brain journal confirms authenticated capabilities **status, screen**, with no
input capability. The /machines renderer uses these same capabilities and adds
input only when advertised. Actual SCREEN_ENABLED=true was preserved; the
example keeps its existing false default. Transport, relay and crypto code were
not changed. Web URL/approval policy was not changed; its taint now revokes control.

## Live-test fixes — 2026-10-07

The original live bug was real: cards described bIT's intended destination,
without OS focus evidence, so approved text could enter Discord. These fixes
separate intent from system focus and refuse Discord input in the node itself.

- Every input card obtains a fresh AT-SPI snapshot from the node via
  `input_focus` and shows `Focused: <application> — <window title>`. Click
  cards separately show the hit-tested target application/window. Type/key
  approvals bind application, window title, PID and window ID; the node checks
  them immediately before execution, and the resident portal helper checks
  independently immediately before keyboard input. A mismatch sends no input
  at the node preflight, discards the old frame/approval, and requires a fresh
  screenshot and another approval. Keys/buttons are still released on failure.
- `CONTROL_BLOCKED_APPS` defaults to `discord`; case-insensitive app/window
  matches deny all input while Discord is focused, and deny Discord pointer
  targets/destinations. The node and resident helper both enforce this even
  if the brain sends an action directly. Missing focus and ambiguous targets
  fail closed. No input card can override a block.
- Terminal cards show `⚠️ Typing into a terminal runs commands.`
- `computer screenshot` skips ✅ while the active, untainted control/screen
  grants remain valid. It still posts 📸, reserves daily screen budget and
  consumes a control step; hitting either cap prevents further work. Input
  cards remain owner/button-only; chat still cannot approve.
- Persona, system and tool guidance require verification of reported focus
  before type/key after a click, recommend Super/name/Enter instead of guessed
  dock icons, and say to stop/report unexpected results without repairing in
  another application. Standalone Super is supported for the launcher. If
  Discord is focused or GNOME exposes no unambiguous accessible focus, Ozzy
  must focus a safe application manually first.
- A persisted one-time warning is armed for two minutes before control expiry.
  It uses the original expiry after restart, and off cancels it.

AT-SPI references checked:
[ACTIVE/FOCUSED state definitions](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/enum.StateType.html)
and [screen-coordinate component hit testing](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Component.get_accessible_at_point.html).
AT-SPI cannot establish universal Wayland stacking, and not every application
exports accessibility. A pointer target is therefore accepted only when exactly
one accessible window contains the point and that window is the active window;
a lone inactive hit could be obscured by an inaccessible application. This
conservative policy can reject legitimate app-switching clicks. It never claims
bIT's model-provided target words are OS evidence. The query reads window
metadata and states only, not editable text or screenshot pixels.

Service-context read-only proof: `systemd-run --user --wait --pipe --collect
--unit=bit-focus-readonly /usr/bin/python3 -B
/home/ozzy/ozzy-os/src/node/input/focus.py` exited **0**. It identified the
actual focused `org.gnome.Terminal` and its window title, PID and window ID.
No portal control session, input action, or image capture was triggered for
these fixes; the earlier consent/Stop proof above predates them. The new focus
checks have mocked node/helper and AT-SPI regression coverage, not a claim of
a new live typing test.

Seven new tests cover node-side Discord/target denials, focus changes between
card and execution, separate real-focus/model-intent fields, terminal warning,
automatic screenshot notices and cap accounting, persisted expiry warnings,
independent helper defenses, and AT-SPI overlap/inactive-window handling. The
existing SDK test now verifies exactly one approval for typing and none for
screenshots, while keeping its image/transcript persistence checks.

Final full suite: **115 passed, 0 failed**. Services were reinstalled with
`/usr/bin/node scripts/services.js install` and confirmed active on `/usr/bin/node`
at the times/PIDs above. Actual `.env` was never edited during this fix:
**CONTROL_ENABLED=false** is preserved. The authenticated node advertises
**status, screen**, with no input. Relay/transport/crypto and web policy are
unchanged.
