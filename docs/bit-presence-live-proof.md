# bIT presence: security, screen update, and live proof

## Database gate: passed

Live project: `xitjzayqnccytsdhubov.supabase.co`. Brain and dashboard configuration point to this same project. After the owner applied migration 0006, the API schema exposes `bit_presence` and selecting the table returns HTTP 200.

Actual hosted checks passed:

- The authenticated owner reads the singleton row.
- A temporary different authenticated user receives zero rows.
- After the brain/service role temporarily changes the singleton's `owner_id` to that temporary user's ID, the owner's authenticated session receives zero rows. The original binding is restored afterward.
- Anonymous SELECT is denied with 42501.
- INSERT, UPDATE and DELETE are denied with 42501 for the owner, the different user, and anonymous clients.
- The brain/service role can upsert the singleton.
- The owner's realtime subscription receives the database change, confirming working publication membership and delivery.
- The actual local dashboard, authenticated as the owner, reads the row and receives a subsequent realtime update without refresh. Browser runtime errors: zero.
- Temporary test account deleted; test sessions signed out locally; original row restored. No emails were sent.

Evidence: `docs/proof/bit-presence/security-check.json`, `dashboard-security.json`, and `dashboard-security.png`. The repeatable hosted test is `node scripts/presence-rls-smoke.mjs --live`; it requires the existing brain and dashboard configuration and intentionally makes temporary hosted test writes. It is separate from the offline unit suite.

## Owner binding

The existing `.env.brain` setting `BITOS_OWNER_USER_ID` is `102c7289-e4eb-4691-85ee-a1f1b099d307`. This equals the actual auth user's ID returned when establishing the owner test session.

The installed brain unit loads `.env.brain`. `startBrainSync` in `src/bitos/sync.js` captures the private settings before scrubbing them from the environment. `runBrain` passes that captured snapshot to `startPresenceMirror`. The upsert in `src/brain/presenceMirror.js:8` explicitly writes `owner_id: settings.BITOS_OWNER_USER_ID`; it does not use a Discord ID or a client-supplied owner. Reading the live row after restart confirmed that the published owner matches this configured auth ID.

## Requested screen changes

- Presence is `screen` for the lifetime of an active `ScreenGrants` grant, even between screenshots. Restored active grants are loaded on brain startup; revoked and expired grants no longer contribute.
- `watching` still reports actual node capture only. The panel separately shows “Screen access active” for grants so a grant is not misrepresented as actual capture.
- Node `capture.screen` is true only during a screenshot operation. `capture.input` separately reports active input control. Continuous input control no longer implies a screenshot is happening.
- A rising node capture report produces a 1.2-second `capturePulse` timestamp. Clients play a stronger ring and scan-row pulse locally; subsequent heartbeats while capture remains on do not retrigger it. Approve and offline still override the pulse.
- Added a lab button for visual QA. Browser proof showed ring width increasing from 5 to about 9 and returning to 5 after the pulse. No runtime errors.
- Fixed duplicate SVG IDs that caused mood updates to target sparkles rather than gradient stops. Browser verification showed hype's actual gradient stops changing to `#ffc04a` and `#ff4f7b`.
- Updated the character bible's screen row and capture-truth rule. The supplied reference HTML remains unchanged.
- The brain and node enforce the original `600000` ms (10-minute) control cap; those policy checks were not modified.

## Validation and restart

- Root tests: 251 passed, zero failures.
- Dashboard tests: 25 passed, zero failures.
- Production build: TypeScript, Vite, and bundle credential scan passed.
- New tests cover grant active without capture, grant expiry, node capture without a grant, grant revoke, rising-edge pulse/replacement/expiry, and pulse priority/detail sizes.
- Brain and OZZY-AI node were restarted successfully, with no active grants at restart. The live brain publishes fresh idle presence with the correct owner ID.

## Live acceptance status

The authenticated desktop and phone-sized local browser dashboards both received the live brain's idle presence and correct chill colors. This is a 390px browser viewport, not a physical phone. No physical-phone observations have been supplied.

| Original step | Status |
| --- | --- |
| 3: owner chat -> listen -> think -> idle | Deferred until chat exists in the dashboard. Discord is sidelined; do not request Discord messages. |
| 4: real model chooses unsure and says so | Deferred until dashboard chat exists. Unit/fixture tests are not real-model proof. |
| 5: MacBook agent -> celebrate/wince | Pending deployment to bit-os.pages.dev, then owner testing entirely through the dashboard on phone and desktop. No approval is simulated. |
| 6: 10-minute control lease | Deferred until control grants exist in the dashboard. The 10-minute cap remains unchanged. |
| 7: OZZY-AI screen grant and capture pulse | Deferred until screen grants/capture exist in the dashboard. Reducer and local visual tests pass; actual dashboard capture is not claimed. |
| 8: stop brain -> offline -> restart | Passed against the live backend using local authenticated dashboards: desktop offline after 50.017s (last update age 90.050s), phone-sized browser after 50.038s (age 90.071s). Recovery after restart: desktop 1.618s, phone-sized browser 1.520s. Not physical-device or Cloudflare-hosted proof. |

The owner confirmed the deployment target is **https://bit-os.pages.dev**, project `bit-os`, Git-connected to `PlanIT2024/ozzy-os` with automatic production deploys from `main`. Deployment is by Git push, not Wrangler. No Cloudflare login should be initiated.

GitHub's Cloudflare Pages check for `eeb913b` is a completed **failure** (check ID `116636136068`). The check exposes only “Build failed” and a private Cloudflare log link, not its detailed error or build settings. The owner's message contained placeholders for build command, root, output, and log error; actual settings were requested. Exact Cloudflare-setting reproduction remains unverified until those values are supplied.

Two separate fresh clones, at `eeb913b` and then-current `main`, were tested from `apps/dashboard` with `npm ci` followed by `npm run build`, without copying ignored environment files or installing root dependencies. Both reproduced `src/runs.test.tsx(2,43): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.` The dashboard lacked a direct `@types/node` development dependency. Previous working-checkout builds accidentally resolved it from the parent repo's installed dependencies.

The dashboard package and its lockfile now directly pin `@types/node` to `26.6.3`, matching the existing root lockfile. A third fresh clone at fix commit `5b3596e`, rooted at `apps/dashboard`, passed `npm ci && npm run build && npm test`: 79 modules transformed, credential scan PASS, and 25/25 tests passed. There were no parent/root node_modules and no copied `.env.local`. This verifies the package dependency closure and the relative import of `shared/bit-orb` from that dashboard root. Test runtime versions: Node `v22.23.1`, npm `10.9.8`. This is a reproduced repo defect, not a claim that the private Cloudflare error log has been inspected.

Screenshots and state logs are in `docs/proof/bit-presence/`. Physical-device observations and a Cloudflare deployment are not claimed.

The offline proof rejects the initial loading/offline state unless a real cached presence timestamp is older than 90 seconds. An earlier exploratory phone result hit that loading state and was excluded; the reported final measurements above use the stricter condition. The brain was restarted automatically after the test and recovered successfully in both sessions.

A three-minute passive observation window recorded live idle presence in both browser viewports but no owner message, unsure expression, task, lease or screen capture. It does not establish steps 3–7. No actual Cloudflare deployment occurred.


## Dashboard-only owner acceptance procedure (after deployment)

Open `https://bit-os.pages.dev` on phone and desktop, reload both, sign in normally, and choose the same workspace. Confirm MACBOOK is online. All actions below happen in the dashboard; no Discord actions are needed. Run each test once on either device and observe the orb on both.

### Run A: agent and completion reaction

1. In **Tasks**, enter `Presence agent proof` in **What needs to happen? Add to inbox…**, then click **Add task**.
2. Click the new task card in **Inbox**. In the **Edit task** panel, scroll to **Run on a machine**.
3. Select **Machine: MACBOOK**. Select the advertised `codex` executor if available and the `sandbox` folder alias if advertised; otherwise use an actual offered executor and disposable folder alias. Select the smallest offered **Lease** (normally 20 minutes; this is the agent-run time budget, not a mouse/keyboard control grant).
4. Replace **Prompt** with: `Without using tools or changing files, explain in about 300 words how this dashboard presence test works. Finish with: presence agent proof complete.` Click **Run**.
5. Close the task panel with **×** at the upper right (**Close task panel**). Scroll to **Approvals** and review the MACBOOK run's prompt, folder and lease. Click **Approve**.
6. Return to the header on both devices. Expect **approve -> agent on MACBOOK -> celebrate -> idle** on success, or **wince** on failure. Celebrate lasts 1.6 seconds and wince 1.2 seconds, so watch both headers through completion. Click bIT to read the state in words. Reopen the task card to inspect **Runs** and **Live log** if it fails.

### Run B: approval holds until the owner decides

1. Repeat the task creation flow with title `Presence approval proof` and the same machine/executor/folder. Use prompt: `Reply with approval proof complete. Do not use tools or change files.` Click **Run**, then close the task panel.
2. Leave the new MACBOOK request pending in **Approvals** for about 20 seconds. Both header orbs should stay amber in **approve**. Clicking bIT should say **Needs approval** and show the pending request. Every new run already requires this initial approval, so no risky command is needed to manufacture an approval.
3. Click **Approve** to dispatch and observe agent/completion, or **Deny** to reject it and expect idle when nothing else is active. For a later command approval, the first **Approve** click arms **Approve command?** and the second click confirms; initial run approvals need one click.

After deployment, wait for the owner's notes. Record phone and desktop behavior separately, including whether **agent** appeared, whether the completion reaction was visible, how long **approve** held, which decision was clicked, and any stale/offline state or layout difference. Do not claim physical-device acceptance until those observations arrive.

## Commit review

The outstanding-file review checked 22 files against configured credential values and common token formats. No matches were found. `security-check.json` has 18 result entries containing only `name`, `ok`, and `detail`, with permission outcomes and the owner's auth UUID; it contains no keys, access tokens, refresh tokens, passwords or session objects. The smoke script reads secrets from ignored existing configuration and does not embed credential values. Screenshots show dashboard/lab output, not login credentials.


## Git-connected deployment follow-up

The owner authorized pushing the local main commits to trigger the existing Pages Git integration. There is no Wrangler login/deployment step. The exact Pages build settings and private build log were not supplied (the message contained placeholders), so the clean dashboard-root reproduction above is explicitly distinguished from an exact match of the Cloudflare configuration.

After pushing, inspect the Cloudflare Pages check on the new main commit. Only a successful deployment check and a served site establish deployment; a Git push alone is not reported as a successful deploy. The two dashboard-only owner tests above should be run after that deployment succeeds. Chat, screen, and control tests remain deferred.

## Mobile panel regression

The offscreen presence panel was reproduced at 320px and 390px and replaced with a safe-area-aware mobile sheet plus a clamped desktop dialog. See `docs/bit-panel-fix.md` for before/after screenshots, bounds and the automated Chromium/WebKit regression tests. Presence permissions and backend behavior are unchanged by this UI fix.

## Orb approvals and Pages dependency isolation (2026-10-19)

The header orb now displays the live pending count and opens urgent-first approval cards above presence details. `ApprovalCard.tsx` is shared with the existing Approvals section. Both receive the single `App.tsx` decision handler: the existing authenticated update, guarded by approval id and pending status, using `decisionPayload`. Owner gating, repeat-click command confirmation, busy state and duplicate-submit protection are preserved. No schema, policies, service permissions or grant limits change.

Realtime continues through the existing dashboard subscription and reload. Expired/decided cards lose their controls immediately, briefly show their final status, then disappear after two seconds of the dashboard clock. If a row disappears from the pending-only query, its final decision is unavailable, so the panel says “Decided elsewhere.” The badge excludes expired/decided rows immediately; offline presence still takes priority. Switching workspace/account remounts presence to clear transient cards.

Local verification: 25 dashboard unit tests, 251 repository tests, and eight browser scenarios passed (Chromium and WebKit). Browser scenarios cover both decision surfaces, command confirmation, denial, urgent ordering, folder/lease/machine detail, remote decisions and removals, expiry, and panel bounds at 320/390/768/1280. These use deterministic local data and never decide a hosted approval.

Playwright moved to `tools/dashboard-browser` with its own lockfile. Pages installs only the dashboard package; its lockfile has no Playwright runtime dependency, and its build never launches or installs browsers. A fresh copy without root dependencies or environment files passed `npm ci` and `npm run build`, resolving `shared/bit-orb` through the existing relative import. GitHub reports the previous 21fd8f4 Pages build failed, but the private install log was not supplied, so its root cause remains unconfirmed.

Phone/desktop acceptance: open the same workspace on both devices, start a MacBook run from its task, then tap bIT when the approval badge appears. Verify the same request appears in the Approvals section, including folder, machine and lease. Approve a run from the sheet and deny another from the Approvals section. Both devices should remove the pending badge/card after realtime refresh; command approvals still require a second confirmation click. No Discord steps are needed. Chat, screen and control tests remain deferred until dashboard controls exist.
