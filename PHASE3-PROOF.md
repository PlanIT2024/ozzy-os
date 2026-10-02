# Phase 3 proof — 2026-10-02

Branch: `phase3-web`, created from `main`.

## Installed SDK contract

`@anthropic-ai/claude-agent-sdk` 0.3.284, bundled CLI 2.1.284.
Installed `sdk-tools.d.ts` defines:

- `WebSearch`: `query`, optional `allowed_domains` and `blocked_domains`.
- `WebFetch`: `url` and `prompt`.
- Search output: structured `results[].content[].url` and optional `searchCount`.
- Fetch output: `url`, `result`, HTTP status and timing; no redirect chain or before-redirect callback.

Only the existing Read/Write/Edit/Glob/Grep/Skill tools plus WebSearch/WebFetch
are enabled. Bash, agents, other built-ins and unconfigured MCP servers stay disabled.
Transport, relay and crypto sources were not changed.

## Web safety and accounting

`data/web.json` persists taint and URL provenance. `data/web-session-keys.json`
associates that state with each resumable conversation; /reset creates a new lifetime.
Only owner message URLs and structured search-hit URLs become fetch provenance.
Fetched page links and search commentary do not. Other public URLs require the
owner button. Cards show complete URLs, including queries; exceptionally long
URLs are shown completely in the attached operation JSON to avoid Discord's
2,000-character limit. Every web decision/completion/failure records the query or
URL and taint in `data/audit.log`.

Memory writes after successful web results and all skill writes require button
approval with a complete before/after diff. Chat text cannot approve. The file is
checked again after approval; changed files must be reviewed again. Untainted
memory writes remain automatic with the 📝 notice.

Public-host preflight rejects IP literals, localhost, credentials, non-HTTP(S),
non-public IPv4 ranges (including CGNAT) and non-global/special IPv6 addresses.
All DNS answers must be public. DNS is checked again after URL approval.
**SDK limitation:** PreToolUse cannot intercept each redirect or pin the SDK's DNS
resolution to our checked addresses. The reported final fetch URL is checked
in PostToolUse, but this occurs after network access and cannot undo a redirect
or DNS-rebinding request. This is not a network-level SSRF isolation boundary.
PostToolUse blocks a reported final URL that fails policy; intermediate redirects
are not exposed. Redirect destinations also cannot be independently approved
before access using the installed built-in tool.

Daily default caps are 50 searches and 100 fetches, configurable through
BIT_DAILY_SEARCH_CAP/BIT_DAILY_FETCH_CAP. Reservations persist before execution;
failed attempts conservatively consume capacity. Actual searchCount, when
reported above one, adds internal searches to usage; the SDK has no WebSearch
max_uses input, so internal fan-out can cross the cap within one invocation.
Further calls are denied. Counts use America/New_York (or TZ) calendar periods.

SDK `ModelUsage.webSearchRequests` reports billable search usage. Inspection of
the installed CLI's cost function verified the expression
`(usage.server_tool_use?.web_search_requests ?? 0) * pricing.webSearchRequests`
is added to token cost. Thus SDK-reported searches have their fee included in
SDK total_cost_usd. Unreported reservations use a separate conservative $0.01
per-search estimate; /budget labels it and includes it in the juice meter.
Resumed cumulative SDK search counts are not charged twice.
Pricing source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
($10 per 1,000 searches, plus token costs). This verifies installed accounting,
not an independently reconciled live invoice.

## Services and real DNS startup proof

Ran `/usr/bin/node scripts/services.js install`; installer reloads, enables,
resets failed state and restarts both units. Templates use StartLimitIntervalSec=0.
The installer uses its invoking Node executable; invoking it with /usr/bin/node
ensures both ExecStart paths use /usr/bin/node.

On 2026-10-02 at 15:59 EDT, stopped the brain briefly and started the real entry
point with a temporary /tmp preload that failed the first Discord DNS lookup.
The preload was only applied to this proof subprocess, never installed in units.
Observed output:

```text
Network connection attempt 1
PHASE3 PROOF: injecting one EAI_AGAIN for Discord DNS
Temporary network error EAI_AGAIN; retrying in 2131ms
node OZZY-AI authenticated online via local
Network connection attempt 2
bIT awake. Node hub on 127.0.0.1:8787
Discord connected as bIT Agent#6243
```

The proof process was terminated cleanly and both services reinstalled/restarted.
`systemctl --user show` confirmed each ActiveState=active, SubState=running,
StartLimitIntervalUSec=0 and ExecStart path=/usr/bin/node.
Final reinstall at 16:02:09 EDT was verified: brain PID 42655 and node PID
42656 were active/running. Journal showed Discord connected at 16:02:10 and
node connected at 16:02:11 after an initial ECONNREFUSED and second attempt.

Discord login and gateway network errors retry forever with exponential delay,
2 seconds to 60 seconds, with jitter and attempt logs. Invalid token/intents
remain fatal. Local-node reconnection uses the same delay and logs attempts;
authentication rejections remain fatal. Existing relay transport behavior remains
unchanged as requested; its existing independent reconnect policy remains in place.

## Tests and live acceptance

Final result: **49 tests passed, 0 failed**, including all existing tests.

Full test command: `/usr/bin/node --test` (run outside restricted sandbox for
loopback sockets and test subprocesses). Automated coverage includes public URL
policy, provenance, taint persistence, exact memory diff approval, untainted
notices, search/fetch caps, SDK fee fallback, DNS retry, fatal authentication,
link embed suppression, and owner-button-only approvals for both skills and
tainted memory. Existing quiet-retry assertion was updated to require the new
attempt logging while retaining connection-transition assertions.

Owner's Discord acceptance checks are pending (no messages sent on your behalf):

1. Ask bIT to search; verify source links and suppressed embeds.
2. Send a public URL and ask for a summary; verify no URL approval is needed.
3. After a web result, ask bIT to remember a fact; verify a diff and ✅ button,
   and that replying “approved” does not approve it.
