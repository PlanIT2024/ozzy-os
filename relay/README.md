# bit-hub: blind WebSocket relay

This folder is a standalone Node.js service. It holds **no brain/node private keys, Claude key, Discord token, memory or skills**. It authenticates relay access, routes opaque ciphertext, and exposes `GET /health`.

## Local test

From the repository root, `npm ci` then `npm run relay` works because the root also depends on `ws`. To run this folder independently, use `npm ci` here then `npm start`.

Generate separate random access tokens locally with `node relay/token.js` (or `npm run token` here). Each output contains a client token and its SHA-256 hash. Give the **token** only to the corresponding brain/node; place only **sha256** on the relay:

```sh
export RELAY_CLIENTS='[{"name":"brain","role":"brain","sha256":"<64-hex-hash>"},{"name":"macbook","role":"node","sha256":"<different-64-hex-hash>"}]'
export RELAY_BIND=127.0.0.1
export PORT=8788
npm run relay
```

Run the command from the repository root. The angle-bracket placeholders must be replaced. The role `brain` must have name `brain`, exactly once. All names compare case-insensitively, and each token hash must be unique. No raw token belongs in `RELAY_CLIENTS`. Generate a new random token for every client; SHA-256 is suitable here because the input is a uniformly random 256-bit token, not a password.

## Railway preparation — deployment is manual

1. Create a service from this repository and choose branch `phase2-always-on` (or a main branch after merging).
2. Set its **Root Directory** to `/relay`. The `Dockerfile` builds only this standalone folder and runs as the non-root `node` user.
3. Set `RELAY_CLIENTS` to the JSON array of client names, roles and token hashes. Keep replicas at **one**; routing is in memory. Disable sleeping/serverless behavior for this always-on relay.
4. The Dockerfile sets `RELAY_BIND=0.0.0.0` **on Railway only**. The server reads Railway's `PORT`. Set the healthcheck path to `/health` and generate a public HTTPS domain.
5. Set the clients' `RELAY_URL=wss://<generated-domain>/`, with their own tokens. Both sides initiate outbound connections. Do not expose an OZZY-AI port.
6. Restart/redeploy the relay after changing client hashes. Restart the brain after changing trust/configuration. Token revocation takes effect when the relay process restarts and existing sockets close.

No deployment, Railway project, or remote resource is created by the repository's scripts. Official references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [healthchecks](https://docs.railway.com/deployments/healthchecks).

## Routing and limits

WebSocket upgrades carry `Authorization: Bearer <token>` and `X-Bit-Name: <client>`. Invalid authentication closes with **4401**; duplicate identities (including a second brain) close with **4409**. Only brain↔node routes are allowed. Forged source names and node↔node attempts close with **4403**.

Binary frames contain a two-byte big-endian routing-header length, a JSON routing header with exactly `from`, `to`, `id`, and opaque payload bytes. The relay reads only the routing header. It neither decrypts nor parses payloads. Application messages, hello metadata, status and handshake contents are all encrypted by the endpoints. The relay can observe names, IDs, lengths and timing. The small JSON control plane carries only readiness, peer availability, and allowlisted rejection reasons; it cannot deliver status or other application messages. A compromised relay can disrupt availability or falsify these unauthenticated availability notices, but cannot forge authenticated application traffic.

Limits: 8 MiB per complete frame (including metadata/ciphertext overhead), 60 messages/sec and 16 MiB/sec per connection, bounded destination buffering, 30-second ping/pong checks with dead sockets removed on the following check. Oversize input closes with **1009**, rate/backpressure with **4429**, malformed routing with **4400**. Logs contain connect/disconnect/error metadata and total byte counts only. No payload logging, disk queue, history or forwarding between nodes exists.
