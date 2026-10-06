# Phase 4 proof — 2026-10-06

Branch: `phase4-scheduler`, created from `main` (`040fcb8`).

## Implementation

- `bit/schedules/daily-brief.md`: weekdays at 08:00 in TZ, machine health,
  today's reminders, open memory goals/projects, yesterday's flags.
- `bit/schedules/weekly-review.md`: Sundays at 18:00 in TZ, using weekly-summary.
- Strict YAML/schema validation, five-field cron, approved schedule writes,
  narrow schedule auto-commits, runtime-only pause/resume.
- Persisted cron claims, two-hour latest-occurrence catch-up, old misses reported
  in the next run; fresh SDK sessions with web disabled unless explicitly asked
  for in the approved schedule body. Existing web hooks still enforce policy
  when web is enabled. No scheduled prompt is treated as an owner message for
  automatic URL provenance.
- Reminder MCP tools resolve natural times in TZ; tainted set_reminder requires
  the owner button with exact resolved time and text. Untainted creation sends ⏰.
- Reminder delivery uses the original #bit thread or #bit fallback, mentions only
  the owner, and marks startup-overdue deliveries late. Persisted delivery claims
  reconcile Discord history before retrying and also use nonce deduplication.
- Minimal unified approval diffs: three context lines, normalized CRLF/CR and
  trailing newlines, inline preview when small and complete attached diff.
- Persona/system guidance prefers Edit for existing memory/skills/schedules.
  /budget states that search fees are included in spend; unreported estimates
  remain explicitly labeled.

Transport, relay, crypto and `src/brain/web.js` are unchanged.

## Validation

`/usr/bin/node --test`: **67 passed, 0 failed**, including all existing tests.
Executed outside the restricted sandbox for subprocesses, test Git repositories
and loopback networking. `git diff --check` passed.

New coverage checks TZ cron parsing and both DST transitions, repeated-hour
no-double-run across restart, persisted catch-up versus skip, pauses/disabled
jobs, budget skips, fresh session/taint behavior, explicit schedule web gating,
button-only schedule/reminder approval (chat cannot approve), exact natural
reminder times, late-on-startup single delivery, interrupted-delivery recovery,
Discord deduplication, original-thread/fallback routing, owner-only mentions,
minimal normalized diffs, /schedule command routing and narrow add/update commits.

Dependencies installed and inspected locally: cron-parser 5.10.1, chrono-node
2.10.2, Luxon 3.7.2, diff 9.0.0. The parser and SDK integration use their installed
APIs/types. npm reported zero vulnerabilities.

## Real Discord proof

Registered guild commands via the configured bot REST API:
`mood`, `machines`, `budget`, `schedule`, `reset`.

Briefly stopped the production brain to avoid a second brain/hub/ledger writer.
A temporary proof process used the real Discord client, NodeHub, Runner, budget,
scheduler and reminder store. It exercised the same `/schedule` owner command
handler using local interaction envelopes; the list acknowledgement was captured
locally, and the daily-brief output was posted to the real Discord channel. This
was a handler integration proof, not a fabricated Discord slash event.

Observed `/schedule list` output:

```text
daily-brief · enabled · next Oct 7, 2026, 8:00:00 AM EDT (America/New_York)
weekly-review · enabled · next Oct 11, 2026, 6:00:00 PM EDT (America/New_York)
```

Observed `/schedule run daily-brief` acknowledgement:

```text
Posted daily-brief: <#1557038451541680285>
```

Fetched the posted output to verify it was a nonempty brief rather than an error:

- Thread: `daily-brief · 2026-10-06`, id `1557038451541680285`.
- Message: `1557038503974666323`, 478 characters.
- Link: https://discord.com/channels/1554194124595269672/1557038451541680285
- SDK spend after proof: $0.2161806 / $10 monthly cap; ledger certain.
- Real OZZY-AI node authenticated to the proof hub; no fake machine results.

The proof process cleaned up the brain lock and hub. Both services were
reinstalled via `/usr/bin/node scripts/services.js install` and restarted.
Final verification after the 10:39:13 EDT reinstall:

```text
bit-brain: ActiveState=active SubState=running MainPID=145711
bit-node:  ActiveState=active SubState=running MainPID=145712
both: ExecStart path=/usr/bin/node; StartLimitIntervalUSec=0
```

Journal confirmed Discord connected and brain awake at 10:39:14 EDT, followed by
OZZY-AI connected/authenticated at 10:39:15 after the node retried an initial
ECONNREFUSED. No service template or transport changes were needed.

## Delivery/restart semantics

A scheduled occurrence is reserved before Discord/API side effects. A crash can
leave an interrupted run, which is reported but never automatically replayed;
this trades replay completeness for the required no-double-run guarantee.

Reminder recovery requires Discord message-history access. It searches back to
the persisted claim timestamp for its unique reminder marker. An unsafe or failed
history check retains the claim and retries with backoff, rather than blindly
sending a duplicate. A deleted delivered message removes reconciliation evidence;
Discord's nonce deduplication is an additional recent-request safeguard, not an
unlimited transactional guarantee. Pending/uncertain reminders are visible through
list_reminders. Runtime files stay under gitignored `data/`.

## Owner live check pending

In Discord: “remind me in 2 minutes to stretch”. Verify the exact ⏰ resolved-time
confirmation, then the owner mention in that thread about two minutes later.
No live test reminder was created on the owner's behalf.

## Reminder approval regression — 2026-10-06

The reported live reminder's audit context was an existing conversation whose
WebFetch completed on October 2. Its tainted state correctly required the owner
button; that existing taint was not cleared or bypassed.

Top-level #bit routing now explicitly requests a fresh Runner session when
starting a thread. The reset is persisted before SDK startup, so failure before
init cannot restore an old resumed session with a fresh taint key. Continuing
thread replies retain their existing session and taint.

Non-file reminder approvals use `action: Reminder` and a resolved-time description,
not a fabricated file path. The card and attached operation JSON show the action,
exact due timestamp and reminder text; file proposals keep their normal diff UI.

Final regression suite: **69 passed, 0 failed**. The new end-to-end test routes a
top-level message through Discord, Runner, permission hooks and the real in-process
reminder MCP server. It verifies automatic saved reminders and ⏰ with no approval
card, then verifies button approval after taint in the continuing thread. It also
asserts the Reminder action label and absence of a file field. A separate test
checks persisted session reset when the SDK fails before initialization.
