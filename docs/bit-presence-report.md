# bIT presence implementation and proof

The dashboard uses its existing authenticated Supabase mirror and Postgres realtime subscription. The Railway relay remains the encrypted brain/node transport. There are no npm workspaces; the dependency-free custom element lives in `shared/bit-orb/src/`.

## Supplied artifacts

`bit/persona/character.md` and `bit/persona/reference/bit-orb-reference.html` are byte-for-byte copies of the supplied Downloads files. The reference is retained unmodified. The component uses `offline` instead of the reference's `sleep` state, real lease timestamps instead of a simulated countdown, and follows the bible's instruction to omit extra highlights in simple/min detail. The reference's paths, proportions, colors, pixel patterns, ring behavior and face logic were ported into the pure face function. Sparkle placement is deterministic for stable rendering.

## Events wired

- Accepted owner Discord message: listening and curious; cleared after response delivery, including errors.
- SDK query lifecycle: thinking while awaiting/consuming model output; cleared in finally.
- Dashboard agent dispatcher: running/recovered jobs with machine name, success celebrate, failure wince, pending approvals and decisions. The existing dispatcher still validates owner and machine before acting.
- Control grants: start/end, active restored grants, original expiry and duration. No permissions, lease durations or approval gates were changed.
- Discord ApprovalRelay: pending/decided via existing mirror callbacks, also when the mirror is disabled.
- Reminder delivery: curious.
- Node hello and heartbeat: actual reported capture state. Missing capture defaults to false. Input capture begins after successful backend startup and ends after backend shutdown; a screenshot operation reports start/end immediately rather than waiting for the 30-second heartbeat. Active Linux RemoteDesktop sessions report input control; screen is true only for an actual screenshot operation. Screen grants now hold screen state; the watching list and stronger capture pulse still require node-reported actual screenshot capture. See the follow-up live-proof report.
- `/mood`: existing saved preference, with New York sage hours computed independently of the server timezone.
- `express`: in-process MCP tool, exact permission name `mcp__presence__express`, available in tainted threads, one accepted expression per ten seconds across runner sessions.

Skipped: there is no separate fine-grained model-thinking event bus, so the SDK query lifecycle provides that state. There is no continuous screen-watch command: existing read-only screenshots are discrete captures; an input portal session provides sustained capture. macOS screen/input backends do not exist. Once-a-day flourishes are intentionally omitted.

## Publishing and database

Apply `supabase/migrations/0005_bit_presence.sql` before restarting the brain with these changes. It adds a single `ozzy` row, service-role writes, authenticated owner-only SELECT under RLS, and realtime publication. The owner is the existing brain-only `BITOS_OWNER_USER_ID`; clients cannot insert, update or change it. No credentials were added to the component or dashboard.

Writes: one startup write, then at most one heartbeat per 60 seconds without changes: **60/hour in steady idle** (61 counting startup at the beginning of a measured hour). Add one write per group of changes coalesced by the 250ms debounce. Busy hours cost roughly `60 + debounced change groups`, usually less because change writes reset the heartbeat clock. No animation, pointer, size or countdown tick writes to Supabase. Failed writes retry the current presence, never historical heartbeat rows.

The client becomes offline after `updatedAt` is older than 90 seconds and recovers with a fresh snapshot. Hidden/offscreen animation loops pause; elapsed wall-clock lease/reaction times catch up on resume. Reduced motion freezes bob, orbit and shake. Idle runs at about 10fps and active states at no more than 30fps.

## Automated/local proof

- Root `npm test`: **248/248 passed**, including the final lifecycle/heartbeat coverage.
- Dashboard `npm test --prefix apps/dashboard`: 25/25 passed.
- Dashboard production build: TypeScript, Vite and credential scan passed.
- Browser `/bit-lab`: cycled 8 states, 5 moods, 4 reactions and 8 sizes, with zero page errors.
- Two component instances using the same 20-minute lease displayed `20:00` and `19:59`: agreement within one second.
- Stale snapshot test: both instances became offline at a timestamp older than 90s and recovered on a fresh timestamp. This used injected timestamps, not a stopped live service.
- Reduced motion: body transform `translate(0 0)`.
- IntersectionObserver: offscreen pauses true; onscreen resumes true.
- Browser screenshots: `docs/proof/bit-presence/bit-lab-full-min.png`, `bit-lab-side-by-side.png`, and `bit-lab-phone.png`. The phone screenshot is a 390px browser viewport, not a physical phone.
- Fake SDK lifecycle test verifies thinking -> idle, tool registration and an unsure expression; this is not evidence that the real model chose unsure.

## Live proof status

Read-only live readiness check: OZZY-AI and MACBOOK are online. OZZY-AI advertises status/screen/input; MACBOOK advertises status/run_agent. Querying `bit_presence` returns `PGRST205` (table absent from the API). The configured checkout has neither a database connection string nor a Supabase management token. The migration has been provided for the owner to apply in the SQL editor.

Not performed: sending a real message and watching a physical phone, eliciting a real model unsure call, dispatching a MacBook job and approving it, granting a live lease and comparing devices, starting OZZY-AI capture, or stopping/restarting the installed brain. Those require the migration and deployment first. No bot-authored message was misrepresented as an owner message, and no owner approval was simulated. Existing control grants are limited to 10 minutes; a 20-minute control grant cannot be tested without changing policy. Agent-run leases support 20 minutes, but are agent execution time limits, not mouse/keyboard control grants.

## Changed files

- Persona: `bit/persona/character.md`, `bit/persona/reference/bit-orb-reference.html`, `bit/persona/persona.md`.
- Presence: `src/brain/presence.js`, `src/brain/presenceMirror.js`, `src/brain/index.js`.
- Event/tool wiring: `src/brain/discord.js`, `src/brain/runner.js`, `src/brain/tools.js`, `src/brain/permissions.js`, `src/bitos/dispatch.js`.
- Node capture truth: `src/node/index.js`, `src/node/input/index.js`, `src/brain/nodeHub.js`.
- Component: `shared/bit-orb/src/face.js`, `shared/bit-orb/src/bit-orb.js`.
- Dashboard: `apps/dashboard/src/BitPresence.tsx`, `apps/dashboard/src/bit-orb.d.ts`, `apps/dashboard/src/App.tsx`, `apps/dashboard/src/main.tsx`, `apps/dashboard/src/style.css`, `apps/dashboard/vite.config.ts`.
- Database/tests: `supabase/migrations/0005_bit_presence.sql`, `test/presence.test.js`.
- Proof: this report and the three PNG files in `docs/proof/bit-presence/`.


## Follow-up

The later security gate passed and screen semantics were revised at the owner's request. Current implementation and validation details superseding the original live-proof status are in `docs/bit-presence-live-proof.md`.
