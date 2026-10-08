# Phase 6 — step-approved Wayland control

Branch `phase6-control`, based on main `93e2753`. Final validation/deployment:
2026-10-08 (round 3 below; live search/input verification pending owner presence). Historical consent and Stop proof:
2026-10-06; first fixes/deployment: 2026-10-07.

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

## Validation and deployment — 2026-10-07 (historical)

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

## Refinements — 2026-10-08 (historical deployment)

The owner reports the Discord block and GNOME Stop working live. These refinements
address standalone Super, Electron frame hit testing and actionable refusals.

### Exact Super exception

A normalized `key: super` with no other keys, text, coordinates or other action
fields is allowed irrespective of focused app (including Discord or unavailable
AT-SPI). It still needs ✅ and the existing active grant, screen, unlocked
session, rate and cap checks. Both the JS node and resident Python helper enforce
the exact exception. `super+enter`, `super+l`, and Super with even an empty text
field do not qualify. The exception does not establish new application focus or
authorize following input. Type/key still obtain real current focus for their
card and re-check it at execution. Shell keyboard focus can be resolved from
SHOWING/FOCUSED/EDITABLE entry states even when its Main stage lacks ACTIVE;
approval binds that element ID too. Editable text/names are never read.

### Real Obsidian investigation

All GUI observations were read-only, from transient `systemd-run --user --wait
--pipe --collect` services. No focus change, click, key, screenshot, application
launch/restart or setting write was performed. The foreground remained Terminal
during the measurements; this is not a claim of a new live Obsidian click test.

Observed with `org.gnome.desktop.interface toolkit-accessibility = false`:

- AT-SPI registered **obsidian**, PID **242874**, window
  **Untitled 1 - PlanIT OZZY - Obsidian 1.14.4**, SHOWING, one top-level child.
- Frame role **23**, logical extents **[0,0,1056,842]**; component contains its
  center **[528,421]**, but `get_accessible_at_point` there returns no child.
- Discord likewise exposes a named frame and bounds with no center child hit.
  Thus missing renderer children do not mean the application/window is absent.
- Other inactive windows, including Nautilus, App Center and Desktop Icons,
  reported hits covering the same areas. The old hit-count-only logic could
  therefore call background overlap ambiguous even with a unique active frame.
- AT-SPI layer/z fields were not useful universal compositor stacking evidence:
  GTK frames reported layer 7, Electron frames layer 3, and z=0 in this sample.
- The revised snapshot, at the measured Obsidian center with Terminal actually
  focused, correctly reported Terminal as the target, not the model's Obsidian
  belief. Service exit **0**; only metadata was returned.

Focused-frame bounds fallback now allows an interior target when there is a
uniquely observed active app/window and valid top-level bounds, even without
inner accessible hit children. The card explicitly labels **focused window
extents; inner accessible hit unavailable**. Inactive ordinary background windows
do not alone defeat that evidence. Intersecting modal/popup overlays, uncertain
focus or geometry, and targets outside the focused frame remain refusals. Any
known blocked-window candidate at the point/destination still denies input,
even if that blocked window might be behind the focused app. This deliberately
keeps the Discord rule conservative. AT-SPI remains unable to prove universal
Wayland stacking/occlusion or unknown transparent/overlay windows; the fallback
is frame evidence, not a claim of knowing the inner widget or universal stacking.
Fresh post-action screenshots/focus and stop-on-surprise guidance remain mandatory.

### Settings and standard accessibility means

No setting change is needed for the Obsidian frame evidence already exposed.
The installed schema describes toolkit-accessibility as whether toolkits load
accessibility modules; its current false value was verified again after deployment.
[Electron documents assistive-technology detection and its accessibility API](https://www.electronjs.org/docs/latest/tutorial/accessibility);
[Chromium documents the renderer forcing flag](https://www.chromium.org/developers/design-documents/accessibility/).
Enabling the setting or relaunching Obsidian with that flag was not tested or
performed, so this proof does not assert what the renderer exposes afterwards.
If Ozzy elects to enable the global setting, the exact command is:

```sh
gsettings set org.gnome.desktop.interface toolkit-accessibility true
```

It asks toolkits across the desktop to load accessibility modules, potentially
exposing more UI metadata/text to assistive clients and adding processing; apps
may need restarting. Restore the observed setting with the same command ending
in `false`. The installed launcher is `/snap/bin/obsidian`; after saving work
and fully quitting it, the per-launch alternative is:

```sh
/snap/bin/obsidian --force-renderer-accessibility
```

It forces renderer accessibility-tree maintenance for that launch, with richer
UI exposure and processing overhead. Neither command was executed.

### Refusals, tests and deployment

JS/portal refusals now distinguish **missing usable accessibility**,
**overlapping windows** and **focus mismatch**, with instructions to focus a
safe app, close an overlay or enable app accessibility. The fixed helper error
codes survive node-to-brain propagation; no raw helper output or editable text
is added to them. Model/system/persona guidance explains the lone-Super exception,
requires fresh observed focus afterwards, and relays the specific refusal cause.

**Full suite `/usr/bin/node --test`: 120 passed, 0 failed.** Five new tests cover:
Discord Super versus immediate type/key, exact exception fields and combinations,
Shell entry/element focus changes, independent Python defenses, bounds evidence
on cards, distinct refusal categories, and unavailable AT-SPI allowing only
Super. Existing AT-SPI tests now cover bounds-only Electron frames, permitted
ordinary background frames, modal overlap denials and out-of-focus targets.
The real SDK image/text persistence and owner-button regressions also pass.

Reinstalled via `/usr/bin/node scripts/services.js install` on Oct 8 at
**14:58:40 EDT / 18:58:40 UTC**. Both units confirmed active/running on
`/usr/bin/node`: brain PID **322931**, node PID **322933**. Discord connected
at 14:58:41; node authenticated at 14:58:42 and advertised
**status, screen, input**. The owner's current **CONTROL_ENABLED=true** was
preserved; actual `.env` was not edited. Toolkit-accessibility remains **false**.
Transport/relay/crypto and web policy are unchanged. No diagnostic control
session was started for these refinements.

## Round 3 — 2026-10-08: deployed fixes; live search/input check pending

### Expected application binding

Every computer input requires `expected_app`, including clicks, key/type, mouse
movement and scroll. Ordinary identifiers are the actual AT-SPI application name
(case-insensitive); use `gnome-shell-search` only for verified overview search.
The node's pre-card `input_focus` validates the declared app against actual focus
and applies input blocks. The brain repeats that check, then shows Expected,
Actual and the actual focused app/window. A mismatch returns **none delivered**
and cannot create a card. Execution independently re-checks declared app and the
card's PID/window/element snapshot in JS and the resident portal helper.

This directly covers the reported mistake: proposing text for
`gnome-shell-search` while Obsidian has focus now fails before ✅ exists. A lone
Super still has the Discord-block exception, but its expected app must match
actual current focus too; it no longer bypasses missing focus. Consecutive Super
presses are refused in the node before approval and again at execution. Input refusal stops the task; guidance explicitly
forbids retrying variations or repairing the result in another app. Screenshots
now report the actual app identifier to help bIT choose expected_app correctly.

### Search investigation and current verification limit

Primary GNOME 50.1 sources checked:

- [Shell D-Bus interface](https://github.com/GNOME/gnome-shell/blob/50.1/data/dbus-interfaces/org.gnome.Shell.xml): OverviewActive is a real read/write boolean property. Only read operations were used for this investigation.
- [Overview search entry construction](https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/overviewControls.js).
- [StEntry accessibility implementation](https://github.com/GNOME/gnome-shell/blob/50.1/src/st/st-entry.c): the wrapper is a PANEL containing an accessible ClutterText child. The source was fetched directly after the web reader could not retrieve that file.

Read-only service-context inspection confirmed OverviewActive **false** during
this run. Shell's Main stage was FOCUSED but not EDITABLE; the expanded metadata
traversal encountered many hidden text widgets and reached 1500 visited nodes
with pending branches. The old depth-15/LIFO/unpruned scan could miss the real
entry. Shell get_id() values were zero in this sample; its accessible D-Bus path
was available (`/org/a11y/atspi/accessible/1082` for the inspected object).

The detector now uses breadth-first visible-tree traversal, prunes hidden app
grid branches, raises the depth bound, requires a focused editable text/entry
and OverviewActive true, binds the entry's D-Bus path as well as its ID, and
reads the overview property again after the scan. While overview is active,
failure to find its focused entry cannot fall back to an ordinary application.
Type/Enter for gnome-shell-search therefore require both signals.

**Live open-overview typing/Enter verification remains pending.** The owner
explicitly requested presence and advance notice. Readiness questions were
sent, but no readiness response arrived during this run. No real input,
overview state change, application launch or new control session was triggered.
The detector is source-informed and regression-tested; this proof does not
claim it has yet been demonstrated against the live focused search entry.
Proposed announced test: with Ozzy present, open/focus search, send Calculator
only if the expected-app guard confirms it, and press Enter only after the same
guard, then close the diagnostic portal session.

### launch_app

A separate SDK tool `launch_app(app)` uses the same owner control/screen grants,
untainted/unscheduled hard gates, action caps and owner-only ✅ relay. It resolves
installed apps through GioUnix.DesktopAppInfo/Gio.AppInfo before a card; its card
shows **Launch <Name> (<desktop id>)**. Approval binds the desktop file's SHA-256
fingerprint. The node re-resolves and verifies it, then uses Gio's launch API in
the graphical user environment. No arbitrary paths, URLs or CLI arguments are
accepted. Discord desktop identities are blocked. Subsequent keyboard/click
operations still require their own expected focus and approval.

Real read-only resolution from bit-desktop-resolve.service found:
**Obsidian → obsidian_obsidian.desktop**, with an installed file fingerprint.
No launch occurred. The namespace was updated to GioUnix after the installed
PyGObject warned that Gio.DesktopAppInfo is deprecated. Mocked tests exercise
launching, changed fingerprints, invalid paths/names, Discord refusal, exact
card text, approval waiting and actual focus reporting. A successful launch
returns a fresh screenshot and real focused app; it never assumes launch implies
focus. Prefer launch_app over keyboard launching.

### Delivery receipts and failure reporting

The portal helper emits metadata-only progress before/after each key-down send.
Successful RemoteDesktop replies increment the confirmed count. Type counts
Unicode characters; combo keys count key-downs. Responses and failures carry
none/partial/all with count and total through LinuxInput, the authenticated node
envelope, NodeHub, thread notices and persisted metadata. Failure closure
summaries also receive available delivery evidence, avoiding a lone ambiguous
“unverified: type” when the node knows what it confirmed.

A failure before dispatch or pre-card mismatch reports none. A failure after
confirmed sends reports the confirmed partial/all count. If a send was in flight
without its reply, or helper/network loss prevented a receipt, the report is
explicitly **uncertain**, including the confirmed lower bound if available.
There is no honest way to infer the final in-flight outcome after connection
loss; this implementation never invents none/all. Counts prove portal-confirmed
sends, not that a particular application inserted the intended text. Delivery
metadata contains no text, image bytes or secrets. All held input is released.

### Tests and current deployment

**Full suite `/usr/bin/node --test`: 126 passed, 0 failed.** Six new tests cover:
expected-app refusal at node preflight/no-card, matching expected/actual cards,
active-overview plus focused-search gates, launch approval and fingerprint binding,
installed desktop resolver safety, delivery none/partial/all notices and state,
and resident helper acknowledged counts on partial failure. Existing tests were
updated for mandatory expected_app and stop-on-refusal. Delivery metadata is also
exercised over the encrypted node/hub path. The real SDK persistence and
conversation-continuity tests pass.

Final service reinstall: `/usr/bin/node scripts/services.js install`,
**Oct 8 15:39:47 EDT / 19:39:47 UTC**. Both units active/running on
`/usr/bin/node`: brain **333222**, node **333223**. Discord connected at
15:39:48; node authenticated at 15:39:49 with **status, screen, input**.
Actual `.env` was not edited; **CONTROL_ENABLED=true** is preserved. Relay,
transport and crypto implementations are unchanged; application RPC metadata
and methods were added inside the existing authenticated channel. Web policy
is unchanged. The only remaining requested proof is the conditional live
search/input test described above.

## Round 4 — installed app launch repair (2026-10-08)

The bit-node journal at **15:42:08–09 EDT** recorded an approved Obsidian
launch followed by `Control installed app operation failed` and a meaningless
0/0 uncertain key-press receipt. It did not contain the underlying exception.
Reproducing the exact LinuxInput/helper path under `systemd-run --user` exposed
it: the helper returned success JSON, then Obsidian appended its CLI-disabled
warning to the same stdout pipe. JSON parsing failed, and the catch replaced
that error with the generic message. No Obsidian setting needs changing.

The standard fix uses GioUnix.DesktopAppInfo's
[desktop-manager API with explicit child FDs](https://docs.gtk.org/gio-unix/method.DesktopAppInfo.launch_uris_as_manager_with_fds.html).
Spawned apps receive /dev/null stdio, leaving the helper JSON pipe exclusive.
The helper checks immediate launcher exit status and reports it numerically.
The non-snap comparison found another issue: Text Editor is D-Bus-activatable;
a short-lived synchronous helper could exit before activation completed. It
now runs Gio's [asynchronous launch API](https://docs.gtk.org/gio/method.AppInfo.launch_uris_async.html)
with a GLib loop and an eight-second activation timeout. Gio documents that
this API waits for D-Bus activation and propagates extended errors.

Snap checks on this system: **snapd 2.77.1**, desktop id
`obsidian_obsidian.desktop`, Exec `/snap/bin/obsidian %U`,
DBusActivatable=false. Its existing GUI process **242874** belongs to
`app.slice/snap.obsidian.obsidian-cef38179-2459-46c5-a178-5da2df08846a.scope`.
The snap establishes its own tracking scope; this failure was not a missing
snap cgroup or session environment. No snap-specific workaround, flags, or
settings were introduced. The installed Text Editor entry
`org.gnome.TextEditor.desktop` uses DBusActivatable=true.

### Live service-context proof

The owner was present and was told before every launch. Diagnostics used a
transient user service running `/usr/bin/node /tmp/bit-launch-exact.mjs` and the
real LinuxInput/helper implementation, not a shell-only launch. The wrapper
logged sanitized metadata only. No mouse/keyboard input, screenshot, image,
portal control session, or setting change was made for these checks.

- Original Obsidian path: valid JSON followed by a CLI warning, reproducing
  the generic failure. Corrected `bit-obsidian-final.service`: success,
  clean 225-character helper JSON, launcher PID **340823**, exit status 0.
  Obsidian is single-instance; subsequent AT-SPI verification found its
  existing GUI PID **242874**, **two windows**, in the snap scope above.
- Original Text Editor comparison accepted activation but later had no
  D-Bus owner. Corrected `bit-editor-async.service`: `activation-completed`,
  clean 229-character JSON, service exit 0. A separate user-service D-Bus
  check returned owner PID **340092** after the helper exited. AT-SPI
  confirmed `gnome-text-editor`, **one window**. Its process is activated
  through the user `dbus.service`.

Launching successfully never means focus is assumed: the existing post-launch
screenshot/focus check and mandatory expected-app input gates remain in place.
These diagnostics verify launch/activation and windows; no typing into either
app was attempted.

### Failure behavior and regression coverage

Sanitized Gio/D-Bus domain, native code and specific message, helper exit/signal,
activation timeout or launcher exit status are logged and carried through the
existing authenticated application RPC to bIT and the thread. Desktop apps
receive only session/locale environment variables, excluding bIT/API/Discord
credentials. Raw app output is not forwarded. Delivery receipts are now created
only for type/key; launch failures cannot produce 0/0 keystroke notices.

An ordinary launch failure ends only the current task, without automatic retry.
The same context cannot continue; a new owner instruction can use the remaining
existing grant. Its original expiry, consumed action count and rate limit remain
unchanged. This avoids requiring another grant for a recoverable application
error. Blocked apps, changed approved desktop identity, lock/cap/expiry or other
safety failures still end control and release held input.

**Full suite `/usr/bin/node --test`: 129 passed, 0 failed.** Three new tests
cover child-output isolation, async activation completion/error, sanitized error
and credential filtering, launch failure task/grant behavior, safety revocation,
held-input release and absence of delivery counts. The existing encrypted
node/hub test additionally verifies specific launch failure classification and
message propagation. Existing real SDK and focus/control safety tests pass.
Sandbox-only test attempts failed due to subprocess/socket EPERM; the complete
suite was rerun outside the sandbox and passed.

Reinstalled with `/usr/bin/node scripts/services.js install` at
**16:37:13 EDT / 20:37:13 UTC**. Both active/running on `/usr/bin/node`:
brain **342861**, node **342863**. Discord reconnected at 16:37:15; node
recovered from the brief startup ECONNREFUSED and authenticated at 16:37:15,
advertising **status, screen, input** at 16:37:16.
Actual `.env` was not edited; **CONTROL_ENABLED=true** is preserved.
Transport, relay, crypto and web policy implementations are unchanged.
The older round-3 overview typing proof remains outside this round's live tests.
