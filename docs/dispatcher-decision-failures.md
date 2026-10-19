# Dispatcher decision rejection and chat startup diagnostics

The follow-up list was committed unchanged as `4dec599`. This change resolves
its dispatcher retry and chat startup diagnostics items without a migration.

A negative RPC response from the matching authenticated node peer now carries
brain-local `nodeRejected` metadata. This does not change the node wire protocol.
The dispatcher treats such agent.decide rejections as permanent, including the
known legacy “Unknown approval or invalid decision” error. Actual hub/relay
offline and disconnection errors retain their existing five-second retry cadence
and ninety-second window. A node rejection whose message resembles a transport
error is still terminal because its source is known.

On rejection, the dispatcher logs the redacted reason once, marks the run failed
with that reason, and sets the task to waiting_on_you. The run is failed before
the approval metadata write, so a restart after that commit cannot resend the
decision. The approval keeps the owner's approved/denied status and gains
`action_detail.kind = agent_decision_failed` plus `failure_reason`; delivery
failure does not rewrite the owner's decision. An in-process failure cache also
prevents another RPC if a database write fails; subsequent scans retry only the
persistence. Existing terminal run checks prevent further delivery after restart.

RPC diagnostic table context is approvals for agent.decide, agent_runs for
agent.run/agent.stop, and nodes for capability discovery. Request parameters,
prompts and credentials are omitted/redacted from diagnostic and stored reasons.

On brain startup, dashboard chat explicitly reports either disabled or:

```
Dashboard chat enabled; initializing owner-scoped realtime subscription.
Dashboard chat subscribed; owner-scoped realtime is ready.
```

The second line requires a SUBSCRIBED callback; the first alone does not prove
a working subscription. Channel errors/timeouts log a credential-free lifecycle
message, and catch-up resumes after reconnection. No owner IDs, keys, URLs or
message text are logged by these diagnostics.

Validation: all 278 repository tests passed. Regressions cover terminal legacy
and tagged rejections, transport-looking node messages, thirty later scans,
restart, persistence failures in both tables, preserved owner decisions, reason
redaction, authenticated response matching, disabled/enabled/subscribed startup
states and reconnect diagnostics. No live decisions or service restart were
performed. The dashboard and node implementations are unchanged.
