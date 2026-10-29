# Relay servers for mobile remote control

_Researched 2026-10-29 from local clones (Orca, Paseo, T3 Code, Superset, Codex) and public docs
(Happy, Claude Code Remote Control, iroh). Caxri's resulting design is
[ADR 0021](../../../../docs/adr/0021-blind-splice-relay.md) and
[docs/mobile/relay.md](../../../../docs/mobile/relay.md)._

How products let a phone reach a coding-agent host behind NAT. Per-product details live in each
product's own note; this file compares them and records what users ask for.

## Comparison

| Product                    | Topology                                                                 | End-to-end encrypted                   | Direct path                                                       | Accounts                         | Self-host                                        |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| Orca                       | Host control socket; per-phone ticketed dial-back socket spliced raw     | Yes (X25519, HKDF, per-direction keys) | Direct gets 2.5 s grace; switch back needs 3 probes, 60 s spacing | Host JWT; phones none            | Relay code public (MIT), token issuer is not     |
| Paseo                      | Same control plus data socket split                                      | Yes (Noise NK)                         | Manual direct routes, latency-ranked                              | None at the relay                | Yes (Apache-2.0)                                 |
| T3 Code                    | Relay is a control plane; data goes through Cloudflare Tunnel            | No (TLS ends at Cloudflare)            | Loopback, LAN, tailnet, public, SSH, relay order                  | Required (Clerk)                 | Heavy (Cloudflare, PlanetScale, Clerk)           |
| Superset                   | Control socket plus ticketed dial-back on Durable Objects                | No                                     | None for mobile                                                   | Required (JWT)                   | ELv2, reference only                             |
| Happy                      | Both sides dial a store-and-forward sync server                          | Yes (client-side encrypted blobs)      | None                                                              | Public-key identity, no password | Yes (MIT, one Docker image with embedded PGlite) |
| Codex remote control       | Host dials the vendor backend; JSON-RPC with acks and resumable cursors  | No evidence of it                      | None                                                              | Required                         | No                                               |
| Claude Code Remote Control | Host polls the vendor API; transcript stored server-side while connected | No                                     | None                                                              | Required subscription            | No                                               |
| iroh (building block)      | Peer-to-peer QUIC; relay only until hole punching succeeds               | Yes (QUIC TLS by endpoint key)         | Automatic                                                         | None                             | Yes; React Native binding is young               |

## Lessons Caxri adopted or avoided

- Orca's control socket plus single-use dial-back ticket keeps one Relay socket per phone and lets
  the Relay splice bytes without multiplexing. Its watermark backpressure (pause at 256 KiB, resume
  at 64 KiB) and direct-path grace and hysteresis numbers were adopted.
- Paseo shows the risk of an unauthenticated relay: a stranger connecting as the same host ID evicts
  the real daemon. Caxri requires an Ed25519 proof for the host ID instead.
- Happy shows the single-image self-host story users like, but its database and offline buffering
  conflict with a Relay that owns no domain state.
- Vendor relays (Codex, Claude Code) are criticized for disconnects after updates and for per-session
  re-enabling; Caxri's Server re-registers on its own and covers every Session at once.

## What users ask for (X posts, July to October 2026)

1. A native phone UI instead of a remote desktop or raw TUI, with seamless Wi-Fi to relay switching
   that does not interrupt a running Agent.
2. Remote control that survives app updates and restarts without per-session re-enabling.
3. The shortest path: same-LAN or Tailscale direct, with a public relay only as fallback.
4. Push when an Agent needs a decision, rather than polling the phone.
5. The computer staying awake and tunnels restarting on their own after a reboot.

Mainland China users report slow Tailscale paths, hosts unreachable after a reboot when the tunnel
did not restart, and hosting in Hong Kong, Singapore, or Tokyo. No product published relay latency
measured from mainland networks.
