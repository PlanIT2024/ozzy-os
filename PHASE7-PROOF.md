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
