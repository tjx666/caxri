---
kind: living
status: current
---

# Mobile Relay

The Relay lets a paired phone reach its Server from outside the LAN or tailnet. It is a separately
deployed, stateless service (`apps/relay`) that joins a phone's WebSocket to a socket the Server dials
back, then forwards frames unchanged. The decision and rejected alternatives are in
[ADR 0021](../adr/0021-blind-splice-relay.md); the end-to-end encrypted stream it carries is the
unchanged [Mobile transport](transport.md).

## What the Relay can and cannot see

The Relay sees the host ID, a hash of each access key, connection timing, and frame sizes. It cannot
read or alter gateway frames: the mobile handshake runs end to end between phone and Server with the
pairing secret or device credential as its preshared key, and every later frame is sealed. The Relay
stores nothing on disk. Restarting it drops current connections; the Server re-registers and phones
reconnect on their own.

## Identity and access

- **Host**: the Server generates an Ed25519 host key once and persists it with the Mobile gateway
  preferences. Its host ID is a hash of the public key. On every registration the Relay sends a fresh
  challenge and the Server signs it, so nobody without the private key can register or replace that
  host.
- **Phone**: the phone presents an access key derived one-way from a secret it already shares with the
  Server: the pairing secret while a QR link is pending, then the device credential. The Server sends
  only the key hashes to the Relay as grants. Pending-pairing grants expire with their link. Revoking a
  device removes its grant, and the Relay closes every relayed connection that grant admitted.

## Connection flow

Wire schemas live in `packages/mobile-transport/src/relay.ts`.

1. The Server keeps one control socket at `/v1/host`, answers `relay-challenge` with `host-register`,
   and sends `grant-update` as devices and pairings change. Its registration asks for a standby
   (`standby: true`); the Relay answers with `relay-standby` and a ticket valid for that registration.
2. The Server parks one idle socket at `/v1/host-data` with `host-standby` and that ticket. The Relay
   keeps at most one per host and closes it with `host-offline` when the control socket ends.
3. The phone opens `/v1/client` and sends `relay-connect` with the host ID and its access key. The
   Relay rejects an offline host or an unknown key before the Server hears about the attempt. A
   reconnecting phone sends its `hello` right behind `relay-connect`, without waiting; the Relay holds
   up to four such early frames and forwards them in order once spliced. A pairing `hello` waits for
   `relay-ready`, since it consumes the pairing code.
4. With a standby parked, the Relay splices the phone onto it at once and sends `relay-spliced` to the
   Server ahead of the phone's frames; the Server hands that socket to the Mobile gateway and parks a
   new standby. Without one, the Relay sends `relay-incoming` with a single-use ticket on the control
   socket, and the Server dials `/v1/host-data` and presents the ticket in `host-accept`.
5. The Relay sends `relay-ready` to the phone. The mobile handshake runs over the splice; a
   reconnecting phone sends its first requests right behind its confirmation instead of waiting for
   `ready`, and the Server answers them after `ready`.

Relay decisions use close codes 4400 to 4599 (`relayCloseCodes`). Across a splice the Relay mirrors
application close codes, so the Server still records the phone's own close reason; a peer that
vanished without a close frame becomes `peer-gone`.

## Route selection on the phone

A pairing link carries `relay` and `relay-host` when the Server has a Relay configured; the phone
stores both with its credential. Each connection opens the direct addresses and the Relay socket together, but
asks the Relay for the computer only after a 2.5 second grace, or immediately once every direct
address has failed; a direct win closes the Relay socket before it has sent anything. The grace drops to
300 ms when the Relay won the previous connection to that computer (remembered across app restarts)
or when the phone is on cellular data and no stored address is on a tailnet: a LAN socket that
answers at all opens well inside 300 ms, so a phone back home still connects directly. While a session is on
the Relay and the app is in the foreground, the phone probes the direct addresses every 30 seconds;
after three consecutive successes, with the Relay session at least 60 seconds old and no request in
flight, it closes with `route-upgrade` and reconnects directly. Recovery after any switch uses the
transport's subscribe-then-snapshot rule, so a running Agent is unaffected.

A relayed connection has no LAN address, so the gateway's plain-HTTP side channels are unavailable
over the Relay. The Android update download falls back to the matching GitHub Release asset
([Mobile updates](update.md#transport)); web previews stay direct-only.

## Configuring a Server

Set `mobile.relayUrl` in Settings › Mobile to the Relay's `wss://` URL (a `ws://` URL is accepted for
a private or local Relay). The Server connects whenever Mobile access is on and the URL is set,
reconnects with backoff after failures, and follows changes to the setting immediately. Phones paired
before the URL was set need to pair again to learn it. Under the field, Settings shows whether this
computer is registered with the Relay (connected, connecting, or cannot connect with the reason of the
last failure); the status row is absent while the URL is empty or Mobile access is off.

## Running a Relay

The image bundles one Node file and runs as a non-root user. Build and test it from the repository
root:

```bash
docker compose -f apps/relay/compose.yaml up --build   # local Relay on ws://localhost:8080
bun run --cwd apps/relay docker:smoke                  # build, run, and exercise a full splice
```

Put TLS in front of a public deployment (a platform load balancer or Caddy) and set
`CAXRI_RELAY_TRUST_PROXY=1` only when that proxy overwrites `X-Forwarded-For`. Any container host
with long-lived WebSockets works (a VPS, Railway, Fly.io). Choose a region close to both the phone
and the computer, because every keystroke echo crosses the Relay twice: users in mainland China
should prefer Hong Kong, Singapore, or Tokyo, measure from both Wi-Fi and cellular before relying on
it, and avoid serverless edge platforms whose default domains are blocked there. One process handles
one region; add regions as separate deployments rather than clustering.

| Variable                                 | Default   | Meaning                                                  |
| ---------------------------------------- | --------- | -------------------------------------------------------- |
| `CAXRI_RELAY_PORT`                       | `8080`    | Listen port; `0` picks an ephemeral port                 |
| `CAXRI_RELAY_HOST`                       | `0.0.0.0` | Listen address                                           |
| `CAXRI_RELAY_BASE_PATH`                  | empty     | Path prefix when the Relay shares an origin              |
| `CAXRI_RELAY_TRUST_PROXY`                | `0`       | `1` takes the client address from `X-Forwarded-For`      |
| `CAXRI_RELAY_MAX_HOSTS`                  | `10000`   | Registered hosts per process                             |
| `CAXRI_RELAY_MAX_CONNECTIONS_PER_HOST`   | `32`      | Relayed phone connections per host                       |
| `CAXRI_RELAY_SOURCE_ATTEMPTS_PER_MINUTE` | `30`      | Upgrade attempts per source address before rejection     |
| `CAXRI_RELAY_SOURCE_PENDING_SOCKETS`     | `8`       | Unauthenticated sockets per source address               |
| `CAXRI_RELAY_HEARTBEAT_INTERVAL_MS`      | `20000`   | WebSocket ping interval; two missed pongs close a socket |
| `CAXRI_RELAY_MAX_PROCESS_BUFFERED_BYTES` | 64 MiB    | Total queued bytes before the largest backlog is closed  |

Each spliced direction pauses its source above 256 KiB queued, resumes below 64 KiB, and closes
with `capacity` when one direction stays above 8 MiB or paused for 10 seconds. The 20 second ping
also keeps idle mappings alive on carrier NATs that drop quiet TCP flows.

## Extending the Relay

The Relay is a byte splice behind a versioned rendezvous, so most future work lands outside it.
Each extension below names the seam it uses and what stays untouched.

| Extension                                       | Seam                                                                                                                         | Unchanged                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| New gateway features (commands, events, Agents) | The sealed mobile transport the Relay forwards blindly                                                                       | The Relay image and its protocol             |
| Another route, such as iroh hole punching       | A new `MobileGatewayRoute` kind in `apps/mobile/src/features/connection/gateway-routes.ts`, raced by the same route selector | Pairing secret, device credential, handshake |
| A wire change to the rendezvous                 | A `/v2/` path family and a new `RELAY_PROTOCOL_VERSION`, served beside `/v1/` until old Servers and phones upgrade           | `/v1/` clients                               |
| A new rejection reason                          | A new code in the reserved 4400 to 4599 range of `relayCloseCodes`                                                           | The phone's 4001 to 4099 reasons             |
| Push notifications                              | A separate content-free service ([issue #499](https://github.com/tjx666/caxri/issues/499))                                   | The Relay stays stateless and payload-blind  |
| More capacity or regions                        | Another deployment of the same image, chosen per Server through `mobile.relayUrl`                                            | Host key and host ID                         |

Scale out by region, not by clustering one URL. One process holds up to `CAXRI_RELAY_MAX_HOSTS`
registrations, and a host's control socket and its phones must meet in the same process. A `/v1/`
request carries the host ID only inside its first frame, so a load balancer cannot route on it;
putting several processes behind one URL needs a `/v2/` rendezvous that exposes the host ID in the
request URL for consistent hashing. Add that only when a single region outgrows one process. Moving
a Server to another region keeps its host key, but its phones pair again to learn the new URL.

## Observability

The Relay writes one JSON line per event to stdout: `relay.host_registered`, `relay.host_ended`
(cause, duration), `relay.connection_spliced` (setup time, whether a standby carried it, and how
many early frames were held), `relay.connection_ended` (cause,
duration, bytes in each direction; a heartbeat timeout, such as a carrier NAT dropping an idle mapping, ends
either kind of socket with cause `heartbeat-timeout`), `relay.rejected` (closed reason), and a `relay.summary` every
minute. Logs never contain addresses, keys, tickets, or payload bytes; a host ID appears only as an
8-character prefix. `GET /health` returns the protocol version and current host, standby, and connection
counts. On the Server, Mobile connection records carry a `route` of `lan` or `relay`, and the Relay
connector records each state transition with a closed cause.

`mobile_gateway.connection_established` splits a reconnect into its legs, all in milliseconds:
`clientGraceMs` and `clientOpenMs` (the phone's route grace and its time until the socket was open,
from the reconnect `hello`), `dialMs` (the Server's dial-back to the Relay, 0 for a standby),
`helloWaitMs` (socket until the phone's `hello`, usually 0 now that the hello travels with
`relay-connect`), `confirmWaitMs` (one more round trip),
`authMs` (the Server's own credential check), and `handshakeMs` (socket until ready). With
`relay.connection_spliced`'s `setupMs` this names the slow leg of a reported slow reconnect; the
benchmark that measures them on simulated links is in [performance.md](performance.md#relay-reconnect-latency).
`mobile_gateway.session_read_summary` times the reads behind the dashboard and a Session open
(`dashboard`, `session` for `mobile.session.show`, `chat` for `mobile.agentChat.read`, `timeline`
for `mobile.timeline.read`), each with `<kind>Reads`, `<kind>TotalMs`, and `<kind>MaxMs` measured from
dispatch to reply. The first read of each kind logs at once; later ones join the minute summary.
