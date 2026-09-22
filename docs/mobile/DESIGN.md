# Caxri Mobile Design

## Purpose

Caxri Mobile is a companion for checking Agent Sessions and unblocking a waiting Agent. It is not
a smaller Desktop workspace or an interactive Terminal.

## Principles

1. Put attention before navigation. A waiting or failed Session must be understandable at a glance.
2. Preserve context during network loss. Keep the last in-memory view visible, label it stale, and
   disable mutations until the connection is fresh.
3. Make authority visible. Pairing, Project access, and reply eligibility are explicit states rather
   than optimistic client assumptions.
4. Prefer one obvious action per state. Pair, open a Session, or send a short reply; do not reproduce
   Desktop command density.

## Layout

- Use a single list-to-detail flow below `700dp`.
- At `700dp` and wider, use a `320dp` Session list and a flexible detail pane separated by one
  semantic border.
- Keep readable content at or below `680dp` wide. Pairing content is capped at `520dp`.
- Use system safe areas on every edge. Do not place primary actions under gesture or navigation
  insets.

## Type and spacing

- Body text starts at `15sp`; core body copy uses `16sp / 24sp`.
- Screen titles use `22sp`; detail titles use `17sp`; metadata uses `13sp`; compact state labels use
  `11–12sp`. Never disable system font scaling.
- Interactive targets are at least `48dp`; primary actions use `52–56dp`.
- Base spacing is `4dp`; common gaps are `8`, `12`, `16`, `24`, and `32dp`.

## Color and state

- Use Desktop's canonical Dracula palette from `@caxri/protocol` in phase one. Mobile components map
  those shared colors to semantic roles through `useMobileTheme()` instead of copying raw values.
- Follow-system appearance, a light theme, and an in-app appearance switch are deferred until they can
  share one reviewed semantic mapping with Desktop.
- Native system chrome and the splash background are pinned to dark Dracula for the same reason;
  do not advertise automatic appearance until a complete light mapping ships.
- Body, muted, primary-action, and danger color pairs must retain WCAG AA contrast in automated tests.
- Never rely on color alone. Every status includes a label and, where useful, a shape or icon.
- `loading`, `empty`, `error`, `offline/stale`, and `ready` are first-class states on every remote
  surface.
- A connection becomes stale after five seconds without a valid server observation. Stale content
  remains visible, while reply and mark-read mutations are disabled.
- Remove the stale banner as soon as a fresh authenticated observation arrives. Do not clear or
  replace the last valid list during reconnect.

## Session priority and state language

- The list order is `NEEDS ATTENTION`, `RUNNING`, then `RECENT`. Unread attention sorts before
  other rows in the first group; rows otherwise sort newest first with stable identity tie-breaking.
- User-facing state labels are `Waiting for you`, `Working`, `Failed`, `Completed`, `Idle`, and
  `Unknown`. Do not expose provider lifecycle jargon.
- A tablet keeps a fixed `320dp` list pane and flexible detail pane. Selection uses a semantic
  left accent and accessible selected state, not background color alone.
- Avoid reordering rows while the user is actively touching or dragging the list. A later refresh
  can reconcile order after the interaction ends.

## Accessibility

- Every interactive element has a stable `testID`, an accessibility role, a concise label, and a
  result-oriented hint when the action is not self-evident.
- Decorative marks are hidden from the accessibility tree. Group status icon and label as one
  announcement.
- Support TalkBack traversal in visual order and reduced motion. No state change depends on a
  transient animation.
- Test default and enlarged text on phone and tablet widths before delivery.

## Terminal preview

- Display at most `16KiB` of server-produced plain text. Never render ANSI control sequences,
  inline images, file links, or OSC actions on mobile.
- Preview is read-only and is never persisted to device storage.
- Distinguish unavailable, stopped, empty, truncated, stale, and ready states.
- Use a `15sp` monospaced presentation. The preview is ordinary selectable text, not an
  accessibility live region; background output must never interrupt TalkBack.
- Render large lists with virtualization and keep preview work chunked around the `16KiB` server
  cap so one busy Session cannot block navigation.

## Client data flow

- Phase one keeps one explicit Session polling owner and does not add a state or query framework for
  a single dashboard flow.
- Do not copy that polling hook into a second feature. When phase two adds another cached remote view,
  background refresh, or cross-screen invalidation, adopt a shared query layer such as TanStack Query
  and migrate the dashboard in the same change.
- Server events remain invalidation hints; the authenticated Server response is the source of truth.

## Short reply

- The UTF-8 payload is limited to `1KiB` and cannot contain control characters.
- Sending is available only for a fresh, waiting Session whose target is its Primary Agent
  Terminal. The server is authoritative for all checks.
- Clear the composer only after an acknowledged send. Preserve the draft after failure.
- Keep the draft when the connection becomes stale and explain the exact disabled reason. The
  server revalidates waiting state, Primary Agent identity, attention generation, and device grant
  immediately before writing to the PTY.

## Pairing

- The first screen says `Pair with Caxri` and `Connect to Caxri running on your computer.` Its two
  actions are `Scan pairing code` and `Paste pairing link`; the footnote points to
  `Settings → Mobile` on the Mac.
- Camera access is optional. Refusal keeps paste pairing reachable and never blocks the rest of the
  app.
- Pairing links and one-time secrets are never written to app-owned durable storage. Choosing Copy
  places the complete two-minute, single-use link on the system clipboard; persist only the
  resulting bounded device credential in the operating system secure store.
- Phase one stores the Mac addresses advertised at pairing time. If the Mac changes Wi-Fi networks
  or receives different local addresses, forget the device and pair it again; automatic discovery
  is intentionally deferred until it can be added without broadening LAN trust.
- Leaving a pairing screen, replacing an attempt, or forgetting a device cancels the owner’s in-flight
  handshake and ignores any late result. Only the current attempt may persist a credential or adopt
  a gateway connection; a cancelled persistence step restores the prior credential when it is still
  current, and an older cleanup cannot remove a newer pairing. A pending clipboard read follows the
  same screen lifetime.
