# Phase 7 — task-approved autonomous control

Branch: `phase7-autonomy`, from main `eb833ae`.
Validation date: 2026-10-09, America/New_York.

## Implementation

- `/control on` selects task mode; `/control on mode:step` preserves Phase 6.
- One owner-only button approves the complete plan, including exact text,
  installed desktop IDs, action types, keys, free-text flags and bounded limits.
- The node independently stores and enforces the approved scope in memory.
  Legacy step RPCs, forged macro flags and out-of-scope actions cannot bypass it.
- Fixed `raise_app` macro launches, verifies focus and, when needed, uses one
  Super → verified overview search → installed app name → Enter sequence.
  Failure stops the task; no retries or improvised fallback.
- Terminals require step mode. Discord remains blocked. Dangerous keys,
  clipboard paste, sending, sensitive screens and unexpected dialogs stop
  autonomous actions. Accessibility checks also run between typed characters.
- Browser inclusion is flagged and taints the thread. Free-text permission is
  separately flagged by app and cannot include terminals.
- One edited progress message has an owner-only Stop button. Stop/off/expiry/
  GNOME Stop/caps cancel input and release held keys/buttons. Ordinary task
  failures retain the parent grant but discard the scope.
- Every action, including internal raise steps, captures a fresh image and
  counts toward limits. Images and proposed typed strings stay out of SDK
  session files, text transcripts, task state and metadata-only audit records.

## Automated evidence

Final `/usr/bin/node --test`: **151 passed, 0 failed, 0 skipped**.
Includes all previous tests and new Phase 7 coverage:

- Single plan approval; owner chat and other users cannot approve.
- Exact text matching, app/action/key scope, explicit free-text flagging,
  hard limits, descriptor changes after approval and immutable grant mode.
- No grant, other thread, scheduled or tainted runs refused.
- Discord-focused raise fallback, successful focus verification and abort paths.
- Discord remains blocked at the node; dangerous/sending keys and terminals
  cannot enter autonomous execution.
- Mid-typing sensitive-screen checks, cancellation/releases, Stop button
  identity/location checks, cap/expiry/GNOME Stop and fresh-plan restart behavior.
- Browser warning/taint, tainted memory approval and later web-result shutdown.
- Large plan attachments retain browser/free-text warnings and exact strings.
- Real installed Agent SDK against a local mocked API executes a scoped task
  with one approval; model receives fresh image results, while images and
  proposed tool text are absent from session files.

`git diff --check` passes.

## Deployment

Reinstalled with `/usr/bin/node scripts/services.js install` and registered
updated slash commands with `/usr/bin/node src/brain/discord.js --register`.
On 2026-10-09 at 12:30 EDT, both user units were active/running and their
`ExecStart` paths were `/usr/bin/node`. Discord connected, and OZZY-AI
reconnected/authenticated with `status, screen, input` capabilities. Startup's
initial ECONNREFUSED was retried successfully. Existing SCREEN_ENABLED and
CONTROL_ENABLED settings were preserved; no session/desktop settings changed.

## Live owner proof — pending

The interactive test has not yet been observed. The owner was notified before
any Phase 7 live input and asked to run, in a fresh #bit thread:

1. `/control on with-screen:true` (default task mode).
2. `open Obsidian and type: hello from bIT`.
3. Leave Discord focused while approving the single plan card.

Required observation: Obsidian becomes the actual focused application, the
approved exact text is typed into an appropriate editor, no additional cards
appear, and the progress message ends with a summary. No Phase 7 real input
has been triggered by this implementation run. Automated proof is not a
substitute for this GNOME/Obsidian live observation.

## Limits

AT-SPI sensitive-screen detection is best-effort: custom-drawn/inaccessible
controls may omit semantics. Screenshot inspection and the persona's stop/
handback rules supplement the node checks; this is not a general visual safety
classifier. Browser plans deliberately taint the entire thread. A new web
result ends the current control session. No Shell extension, X11 path or new
transport/relay/cryptography behavior was introduced.


## Live preparation failure fix — 2026-10-09

### Root cause and reproduction

At 12:35:35 EDT the node logged a `list` helper-protocol failure. The actual
Gio helper successfully produced **24,794 bytes for 96 installed apps**, but
`LinuxInput.appOperation` used a **16,384-byte stdout limit**. Node raised
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; the original reporting discarded that
string error code and reported only “helper failed”. The desktop-file
fingerprint calculation itself was working.

A transient user-service diagnosis confirmed the size and overflow. At
12:43:52, the same `input_list_apps` request was reproduced through the
**actual running bit-node.service**, via the existing authenticated NodeHub.
That diagnostic's task-mode grant ended with zero actions.

Listing now has a bounded 1 MiB limit; individual resolution/launch replies
have a 64 KiB limit. Overflow errors retain their native code and operation
stage, with no raw stdout exposed. Desktop-file read failures identify the
app and exception type. List filtering includes StartupWMClass so a blocked
entry cannot abort the entire list merely because its display name differs.
Preparation errors post their specific listing/resolution/fingerprint stage
directly to the thread, stop that attempt, and leave the grant's mode unchanged.

### Why the second grant used step mode

The journal records an **owner slash interaction at 12:36:07**, followed by
replacement of the original grant and creation of the new one at 12:36:08.
The corresponding Discord response identifies the owner and `control on`
interaction `1558156116179943576` and reports step approvals. bIT had suggested
`/control on mode:step` in its 12:35:39 reply. The deployed handler selected
`getString('mode') || 'task'`: step mode therefore corresponds to an explicit
step option on that owner interaction, not an automatic tool fallback.
The old log did not retain the raw option payload, so that last attribution
is inferred from the deployed code path rather than a recorded option value.

For completeness, the lower-level brain/node APIs previously still defaulted
to step for old tests. Both now default to task; the existing Phase 6 tests
explicitly request step. Step-session restoration explicitly preserves its
original mode. New journals record requested/effective mode and owner ID;
grant audit records retain mode, actor and source. bIT has no grant/mode tool,
and its guidance forbids replacing, renewing or switching grants. Preparation
failure tests assert no replacement `input_start` and no mode change.

### Real cancelled-card proof (passed)

At **12:48:39–12:48:42 EDT**, after reinstalling the fixed node:

- A preparation-only harness used the production `runBrain`, `ControlTasks`,
  NodeHub and Discord ApprovalRelay code in a transient user service, with
  **bit-node.service** handling the real helper requests. The normal brain
  was temporarily stopped to avoid concurrent ownership of its hub/lock.
- Task-mode grant `f05af421-4ab3-45e4-bd08-e283fcdd017a` listed all 96 apps and
  resolved `obsidian_obsidian.desktop` and its actual fingerprint.
- The genuine plan card was sent and fetched back from Discord, with its two
  owner decision buttons and exact `hello from bIT` text in the plan.
- The approval was **cancelled without approval**. The fetched final card had
  “❌ Denied … (cancelled)” and no buttons. No task scope was started.
- Node action count was **0**; no application launch, key, pointer action or
  screenshot ran. The portal helper exited cleanly and the diagnostic grants
  were revoked. No remote-control session was left active.

[Cancelled proof card](https://discord.com/channels/1554194124595269672/1558159268648058892/1558159280564211742).
Approval ID: `07ada87e-2d98-4793-bb01-baa02bf88813`.

This proves real app discovery, scope preparation and card delivery/cancellation;
it does not claim the original approved Obsidian typing test has passed.

### Final validation and deployment

Full suite: **156 passed, 0 failed, 0 skipped**. New coverage runs the real
Gio helper with 160 fixture desktop files, proves the old buffer would overflow,
checks fingerprints and blocked WM classes, and verifies preparation failures,
task defaults, explicit step selection and owner provenance. All earlier tests
remain enabled. `git diff --check` passes.

Services were reinstalled, then restored to the standard brain/node entrypoints;
both are active/running on `/usr/bin/node`. Existing SCREEN_ENABLED and
CONTROL_ENABLED values were preserved. No transport, relay or crypto change.

## Raise escalation / encoding fix — 2026-10-09

### Root cause

The failed 14:01:25 action was the macro's **launch_app**, before any launch,
Super press or Enter. The old error combined all hazard flags into one message.
Read-only inspection of the same real Discord and Obsidian windows reproduced
an `AttributeError`: AT-SPI returns null child entries in these Electron trees,
and the scanner called `get_state_set()` on null. `focus.py` converted that into
`accessibility-incomplete`; the task policy then called it a generic sensitive/
sending/unsaved/dialog escalation. The original log did not preserve individual
flags, so the exact old flag attribution is reconstructed from that real-tree
reproduction and the executed code path.

There was a separate recipient bug: launch_app checked the *pre-launch* focused
Discord window's hazards, although it sends no input to that window. The fixed
policy checks the approved installed desktop entry for launches; screenshot
inspection is also permitted without treating it as input. The macro's lone
Super goes to Shell and does not inherit the previous app's hazards. Shell
search typing/Enter require verified Shell search focus and evaluate that Shell
window. Actual pointer/keyboard actions evaluate their actual recipient window;
background or overlapping-window labels do not contaminate the selected target.

### Reporting and tests

Distinct rules include `sensitive_screen`, `credentials`, `unsaved_work`,
`unexpected_dialog`, `sending_action`, `closing_action`, `clipboard_paste`,
`accessibility_incomplete`, `terminal_input`, and `dangerous_key`. Node/helper
failures carry rule, macro step number and evaluated app/window identity through
the existing application RPC. The thread receives the specific failure directly.
Matched accessibility labels and editable values are never included. Focus and
Discord blocks remain enforced independently; genuine recipient hazards still
stop input, including between typed characters.

The real hazard/focus/resident-helper modules are exercised with accessibility
fixtures containing Electron null children, background sending controls, stale
Discord ACTIVE state while Shell search has actual focus, and a real password
role appearing in the Shell recipient. The full node/brain test reproduces
Discord → fixed raise → exact approved typing with one card; separate tests
verify genuine Shell hazards stop the macro and reason metadata reaches the
thread without typed/detected content.

### Attachment encoding

The old Discord card itself contained correct Unicode. Fetching its attachment
showed valid UTF-8 bytes but HTTP `application/json; charset=ISO-8859-1`, which
renders the UTF-8 middle dot as `Â·` in charset-aware viewers. Approval JSON now
uses ASCII Unicode escapes, preserving exact strings under either decoding.
The regression includes `hello · café 😀`, checks ASCII attachment bytes and
round-trips the exact text after ISO-8859-1 decoding. Card text remains Unicode.

Full suite before live proof: **161 passed, 0 failed, 0 skipped**. Services were
reinstalled on `/usr/bin/node`; SCREEN_ENABLED and CONTROL_ENABLED preserved.

### Live proof status

A real SDK run, production brain code/Discord ApprovalRelay and deployed
bit-node.service prepared a single Obsidian plan in the live-proof thread.
Card: https://discord.com/channels/1554194124595269672/1558211996900397128/1558212034611384322
The owner was told before input and asked to approve while Discord was focused.
Result to be recorded after owner approval; no successful input is claimed here.

The 16:18 live proposal was **not approved** before expiry. At 16:28:10 EDT
the node ended the grant with count 0 and exited the helper cleanly. The real
SDK run recorded one card, `accepted:false`, zero steps/actions, and reason
`expired`. The normal brain/node units were restored after the diagnostic.
The owner was asked for readiness before any fresh live proposal. The required
approved Discord-focused raise-and-type proof remains pending; this fix is not
reported as live-verified. Final full suite: **161/161 passed**.

## Activation timing / selected search result — 2026-10-09

The 16:34 owner-approved run reached Enter at 16:34:50 EDT. At
**16:34:53.300 EDT** its control audit recorded the verified key's focus as
**unknown**. The historical record has no app/window identity for that missing
focus and no repeated observations. It cannot establish which window eventually
came forward; the owner's supplied screen-status field remained a placeholder.

The verification path used a focus snapshot taken before capturing the image.
For launch, the 16:34:29.021 audit said Discord, but the subsequent fresh check
before Super saw Obsidian. Thus launch had activated Obsidian during capture,
and the macro unnecessarily entered Overview based on an earlier sample.
Capture now refreshes focus before returning its result. That prevents a
needless Super fallback when launch has already focused the target.

After macro Enter, the node polls read-only focus at 200 ms intervals for up to
3 seconds, requiring **OverviewActive=false AND the approved target app focused**.
It logs every observation's timestamp, elapsed time, app/window identity,
overview state and missing-focus reason. These polls are not input actions and
do not consume steps. The final verification image is captured after focus
settles. Stop, expiry and grant changes are checked before and after every read.
A bounded per-read timeout and focus-only scan avoid full hazard traversals in
the activation wait; actual input still uses full recipient safety checks.

Before Enter, the node examines the showing, selected accessible Overview
result. The installed GNOME 50 search.js marks its default result selected;
AppSearchProvider creates AppIcon objects for desktop entries. The result helper
recognizes the installed AppIcon structure (icon container, BaseIcon and empty
running-dot widget), distinguishes remote file/list results, and binds the
visible app name to a unique installed desktop ID. It must match the approved
app ID and name; otherwise the macro stops and reports only the app/file name.
Missing or unfamiliar accessibility is refused. The resident helper repeats
this check immediately before delivering Enter, preventing a changed result
between node preflight and input. Editable search text and result descriptions
are not read. GNOME source was inspected directly from the installed
`/usr/lib/gnome-shell/libshell-18.so` resources, search.js/appDisplay.js.

Regression coverage includes delayed activation, stale launch focus during
capture, wrong applications, a file named “Obsidian”, and a result changing before
Enter in the real Python helper path. Full suite: **165 passed, 0 failed, 0 skipped**.
Services reinstalled with `/usr/bin/node`, preserving existing screen/control flags.

Live proof was prepared through the real SDK/Discord brain code and deployed
bit-node.service. The single plan card is:
https://discord.com/channels/1554194124595269672/1558219254497681559/1558219285283733586
The owner was notified before input, joined to the proof thread, and notified
there that the card is ready. Outcome will be recorded after owner approval;
no successful live input is claimed yet.

The live card was not approved before expiry. At **16:57:01 EDT** the node
ended the diagnostic grant with count 0 and the helper exited successfully.
The real SDK/Discord run recorded one card, `accepted:false`, zero steps/actions,
and reason `expired`. No launch, key, pointer action or screenshot ran. The normal
brain/node services were reinstalled and restored afterwards. **The required
approved Discord-focused raise-and-type proof remains incomplete**; no fresh
grant was automatically issued after the timeout.
