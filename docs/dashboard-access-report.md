# Dashboard screen/control access — sections 1–5

Prepared on `dashboard-grants` from main `73fd997`. Migration 0009 is prepared,
not applied to the hosted database. No production service was restarted, no live
screen was captured, no machine was opted in, and nothing was pushed. Section 6
live proof is deferred. Deploy the updated node, brain and dashboard together
only after the owner applies and verifies 0009; older nodes fail closed on the
new grant protocol.

## Discord approval finding and chosen behavior

Discord currently has **one approval per input step**, not one approval per task.
`ControlGrants.authorize` creates a unique operation approval, the Discord relay
binds it to the owner/channel/message, and `execute` consumes the exact operation
receipt. A changed frame/grant/focus invalidates it. Screenshots under the grant
are automatic; input is not. There is no plan cache or hazard-based task
preapproval to copy.

The dashboard preserves that stricter behavior. The control grant card shows the
requested plan, but accepting it grants access only. Every proposed input step
has a separate owner card containing the exact action, target, text and observed
focus. Outside-plan actions cannot inherit authorization. Existing focus,
blocked-app, launch/fingerprint, screenshot freshness, coordinate, denial and
failure checks remain. This deliberately does not implement a broader task-wide
input authorization that Discord does not have. Discord slash commands, screen
15-minute cap, control 10-minute cap, daily capture cap and action caps remain.

## Local opt-in and kill switch

Run these commands **on the machine itself**, after installing the new node code:

```sh
# Default is disabled. Show both independent policy flags and duration caps.
npm run grants:remote -- status

# Read-only screen access, capped at five minutes per approved request.
npm run grants:remote -- enable --screen --screen-minutes=5

# Also permit control. Control implies screen and uses the shorter bound.
npm run grants:remote -- enable --screen --control --screen-minutes=5 --control-minutes=5

# Immediate local kill switch: ends every active screen/control grant.
npm run grants:stop

# Disable both remote grant kinds and stop all active grants.
npm run grants:remote -- disable
npm run grants:remote -- status
```

`data/remote-grants.json` is mode 0600, defaults to screen/control disabled, and
stores independently enabled kinds, limits and a generation counter. Screen
limits cannot exceed 15 minutes and control cannot exceed 10. No grant RPC or
MCP tool writes this policy. Updating it revokes existing grants. Stop/Disable
advance its generation, invalidating older approved requests and in-flight starts.
A mode-0600 local Unix socket delivers the kill request immediately; a 100ms
policy watcher and persisted generation also cover an absent socket/node restart.
Enabling `--control` preserves existing screen opt-in; both are required for
remote control. Existing SCREEN_ENABLED/CONTROL_ENABLED and GNOME availability
are additional prerequisites, never overridden by remote opt-in.

A GNOME notification announces the grant kind and remaining m:ss on start and
announces its end. Notification failure denies startup. Existing per-screenshot
notifications remain. The local desktop's existing GNOME portal consent/Stop
behavior remains; this does not bypass OS consent.

## Authorization and lifecycle

`access_requests` holds screen/control requests and brain-only exact input-step
requests. `access_grants` holds actual screen/control activation state; control
uses the same screen authority as its parent. Conversation/workspace/owner
bindings use composite foreign keys.

Requests create cards, never authority. A machine card can create the same
pending request for a selected conversation. Non-enabled machines show “Not
enabled on MACHINE; turn it on at that machine.” The owner duration picker is
bounded by the request, existing caps and mirrored local policy. Control requires
the five-second second confirmation by explicit kind. The database decision
allows only status, decided_by and granted_minutes. Its trigger requires
`decided_by = auth.uid() = node.owner_id`, checks the policy generation and limits,
and supplies decided_at itself. RLS independently checks ownership. Clients
cannot create input-step requests or active grants, change request details, or
clear a grant's Stop flag.

The brain revalidates ownership, workspace membership, taint, capabilities,
current node policy, decision time, generation and duration. It claims activation
once, sends the grant to the authenticated node, starts any associated control
session, checks cancellation again, then publishes confirmed runtime authority
and presence. Accepted access resumes only the plan on that request card in its
original conversation; the existing Runner/permissions still gate every tool and
input step. This continuation has a stable reply ID and is not replayed on restart.

A database grant row, legacy JSON grant, or their combination cannot expose
screen/input tools. The Runner requires a private runtime activation, matching
owner-approved request and active grant rows, exact scope/machine, and a fresh
node confirmation. A brain restart ends orphaned dashboard grants instead of
rehydrating authority from rows. Scheduled jobs cannot request or use access.
Chat words never write decisions. Taint ends both screen and control for that
conversation, cancels its pending input waiters and blocks new requests; persisted
web taint also blocks approval activation after restart.

Every screen RPC carries its grant ID and conversation key. The node rejects
missing, mismatched, expired, revoked or stale-generation grants before capture,
and rechecks after capture before returning pixels. Its persistent ledger
prevents replay after revocation/restart. Control binds to that screen authority
and conversation, including in persisted control state; it cannot outlive the
screen grant. Node timers enforce expiry without the brain. Screen revocation
stops its input session. Control action caps, original expiry, rate/focus/safe-key
checks and release behavior remain enforced locally.

Realtime owner Stop drops runtime authority and sends node revocation outside
the background policy polling queue. Local kill is independent of Supabase and
the brain. Parent-screen revocation and local GNOME Stop also close the access
state. Task events and brain/node audit files contain grant/use/stop/expiry
metadata, never screenshot bytes. Dashboard grants use the new tables and direct
confirmed presence, without generating legacy Discord tasks/lease records.

## Migration and verification

- Migration: [`0009_dashboard_access.sql`](../supabase/migrations/0009_dashboard_access.sql)
- Read-only post-application checks: [`access-verification.sql`](access-verification.sql)
- Local integration runner: `node scripts/check-access-sql.mjs`

0009 also fixes the existing approvals gap: both RLS and
`guard_approval_decision` require the target machine's owner. Its tests include a
second member of the same workspace, and deliberately broaden RLS/column grants
to prove the triggers still reject unauthorized decisions and request mutation.
The local-policy metadata mirror is protected against client inserts/updates.
New access tables have owner-only RLS, narrow column grants, Realtime publication
and a PostgREST schema reload. Existing approval payload immutability remains.

## Validation

- `npm test`: **300 passed**, including grant scopes, seeded rows, taint,
  persistence/replay, approved-plan continuation and legacy Discord regressions.
- Dashboard tests: **30 passed**, including duration bounds, explicit control
  confirmation and non-owner rejection.
- Chromium/WebKit browser suite: **20 passed**, including actual card handlers,
  exact decision/Stop payloads and the existing mobile keyboard/chat regressions.
- TypeScript/Vite build: passed without chunk-size warnings. Bundle credential
  scan: passed.
- Disposable PostgreSQL 16: migrations 0001–0009 and 0009 replay passed; access
  ownership, immutable fields, policy/duration caps, Stop-only grants, protected
  policy mirrors and existing-approval second-workspace-member rejection passed.
- Local node/brain fixture Stop paths completed in under two seconds, including
  the local Unix socket and priority Realtime route. Node timers expired screen
  and control without a brain connection. Physical GNOME and hosted/network
  timing remain for the explicitly deferred OZZY-AI live proof.

## Files changed

- Node policy/enforcement: `src/node/grants/{policy,index}.js`, `src/node/index.js`,
  `src/node/input/{index,linux}.js`, `scripts/grants.mjs`, root package scripts.
- Brain authorization/integration: `src/brain/{access,runner,screens,controls,
  permissions,nodeHub,index,dashboardChat}.js`.
- Dashboard: `Access.tsx`, `ApprovalCard.tsx`, `Chat.tsx`, `App.tsx`, `model.ts`.
- Schema/verification: 0009, verification SQL, disposable SQL runner and RLS fixture.
- Tests: node/brain access suites, screen protocol fixtures, grant-card unit tests,
  shared node/browser fixtures and browser access scenario.
