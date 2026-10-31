---
kind: living
status: current
---

# Mobile page preview

A `control` device can open a web page that a Session serves on the computer, such as the dev server
an Agent just started on `localhost:5173`, in the phone's in-app browser. Dev servers usually listen
only on loopback, so the phone cannot reach them directly even on the same network; Server Core
proxies them over the gateway address the phone is already connected to.

## Entry point

The Session header shows a globe chip beside the pull request chip while at least one of the
Session's processes listens on a TCP port. One port shows its number and opens the page on tap; several
show a port count and open a menu of `port · process` rows. The chip polls `mobile.preview.list`
every 10 seconds only while the Session screen is focused, the app is in the foreground, and the
connection is up over a direct route, and it never appears for `view` or `reply` devices. Over the
Relay the phone cannot reach the gateway's plain-HTTP side, so it neither polls nor shows the chip,
and `mobile.preview.list` answers an empty list without reading ports. A failed open shows an alert and
refreshes the list, which hides a port that stopped listening.

## Which ports belong to a Session

`mobile.preview.list` runs `lsof` twice: once for every listening TCP socket, then for the working
directory of each owning process. A port is offered only when its process works inside one of the
Session's directories: the Workbench root, plus each Terminal's launch `cwd` and reported `agentCwd`
(which covers a linked worktree outside the Project root). Server Core's own listeners are excluded.
A wildcard bind maps to the loopback of its address family; when a port listens on both families, the
IPv4 loopback is used. `lsof` failing reports `UNAVAILABLE`.

`mobile.preview.open` repeats the same lookup and refuses a port outside the Session with
`NOT_FOUND`, so the phone cannot name an arbitrary port on the computer.

## Proxy

Each opened target gets its own plain-HTTP listener on the gateway address (a fresh port), so a page's
absolute paths and its WebSocket keep working unchanged. Listeners are reused per address and target,
capped at eight (the least recently used one is evicted), and close after 15 minutes without traffic
or open WebSocket, or as soon as mobile access is disabled or Server Core stops.

1. `mobile.preview.open` returns `http://<gateway address>:<listener port>/__caxri_preview__/<token>`
   over the sealed channel. The token is single-use and expires after 60 seconds.
2. The first request trades it for an `HttpOnly`, `SameSite=Lax` cookie named after the listener port
   and redirects to `/`.
3. Every later request, including a WebSocket upgrade, must come from a private peer address, carry
   that cookie, and belong to a device the registry still authorizes at the same generation with the
   `control` role. A revoked device's cookie is forgotten, so re-pairing does not revive it. Refusals
   answer `403` with a short plain-text explanation.

Requests are rewritten to look like a browser on the computer: `Host` and `Origin` become
`localhost:<port>` (dev servers such as Vite reject unknown hosts), a proxy-origin `Referer` is
rewritten, and the preview cookie never reaches the dev server. Responses keep the page on the proxy:
an absolute redirect to the same local port becomes a path, and `Domain=` is stripped from
`Set-Cookie`. When nothing answers on the target, the proxy returns `502`.

## Diagnostics

`mobile_gateway.preview_opened` records whether an open `started` or `reused` a listener.
`mobile_gateway.preview_closed` records one listener lifetime: closed `reason` (`idle`, `cleared`,
`evicted`), `durationMs`, proxied `requests` and `upgrades`, `upstreamErrors`, and refused requests by
cause. Neither records a URL, header, or content.

## Code

- [Contract](../../packages/protocol/src/mobile/mobile-preview-contract.ts)
- [Port discovery](../../apps/server/src/core/mobile/preview/listening-ports.ts) and
  [Session filter](../../apps/server/src/core/mobile/preview/targets.ts)
- [Proxy](../../apps/server/src/core/mobile/preview/proxy.ts)
- [Header chip](../../apps/mobile/src/features/browser/preview-chip.tsx)

See [Mobile authorization](authorization.md) for role grants and [Mobile transport](transport.md) for
the gateway itself.
