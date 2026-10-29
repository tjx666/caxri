---
kind: adr
status: accepted
---

# Blind-splice Relay with host-key identity

- Date: 2026-10-29
- Refs: [ADR 0007](0007-remote-access-and-project-authorization.md), [Mobile Relay](../mobile/relay.md)

The Caxri Relay is a stateless rendezvous service that splices a phone's WebSocket to a socket the
Server dials back on demand, and forwards every frame unchanged. It never terminates the mobile
gateway handshake, so the existing end-to-end encrypted stream, its authority checks, and its
recovery rules apply unchanged whether a phone arrives over the LAN or the Relay. The Relay holds no
accounts and no durable state: a host proves an Ed25519 key whose hash is its host ID, and a phone
presents an access key derived one-way from the pairing secret or device credential, of which the
Relay keeps only hashes. Everything the Relay knows is rebuilt from the Server's next registration,
so a single container with no Redis, Postgres, or object storage is a complete deployment, and the
same image serves self-hosters and any future official instance.

## Considered Options

- **Account-backed relay that can read traffic** (Codex remote control, Claude Code Remote Control,
  Superset, T3 Code's Cloudflare Tunnel): simplest routing and enables server-side push content, but
  requires a Caxri account system and puts transcripts and Terminal bytes in a third party's reach.
- **Store-and-forward sync hub** (Happy): works while the host is offline, but needs a database and
  turns the Relay into a domain-state owner, which ADR 0007 rules out.
- **Unauthenticated blind relay** (Paseo): equally private, but anyone who knows a host ID can evict
  the real host. The host-key proof closes that hole without accounts.
- **Peer-to-peer with relay fallback** (iroh): best latency when hole punching works, but its React
  Native binding and macOS Intel support were not mature enough to ship; it remains a later option
  behind the same pairing link fields.
- **Cloudflare Workers with Durable Objects**: cheap global edge, but mainland China reachability is
  unreliable, per-message backpressure cannot be expressed, and self-hosting would need a second
  runtime implementation.

## Consequences

The Relay cannot send meaningful push notifications or buffer work for an offline host; push stays a
separate, content-free extension (issue #499). A relayed session has no LAN address, so plain-HTTP
side channels such as the Android update download are unavailable over the Relay.
