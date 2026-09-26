# Caxri Mobile Design

## Purpose

Caxri Mobile is a remote control for Agent Sessions running on the owner's own computer. Over the
local network or Tailscale, the owner can see which Session needs them, read the Agent conversation,
watch and drive the live Terminal, send instructions, stop an Agent, start a new Session, and review
the resulting changes.

It is not a reduced Desktop workspace. File editing, the file tree, extensions, settings, and
multi-pane Terminal layouts stay on Desktop.

## Principles

1. Put attention before navigation. A waiting or failed Session must be understandable at a glance.
2. Reliability is a feature. Recover the connection quickly, never lose a draft, and never claim a
   delivery the Server did not confirm.
3. Server Core owns authority. Hiding a control is presentation, not policy; every mobile request is
   re-authorized against the device grant, Project, Session, and current Agent generation.
4. Never disturb Desktop. Observing, creating, or sending from mobile does not change Desktop's
   selected Session, Terminal attachment, or Terminal size. The only exception is an explicit,
   server-leased Terminal take-over (see [Terminal](#terminal)).
5. Prefer one obvious action per state. Do not reproduce Desktop command density.
6. A tablet adds panes, not flows. Every task has the same steps on phone and tablet.

## Scope

In scope:

- Pairing over LAN or Tailscale IPv4, fast reconnect, and foreground recovery.
- Session home ordered by attention, with a Project filter.
- Session screen with four segments: **Conversation**, **Terminal**, **Changes**, and **Project**
  (read-only Files, Status, and extension panels, mirroring Desktop's right sidebar).
- Composer that types into the Primary Agent Terminal, and a Stop action.
- Creating a Session in a granted Project, and adding a Project from a `control` device.
- Phone layout plus a tablet split layout.

Current implementation boundary: live Terminal observation and control are Android-only. iOS
shows an unavailable state for this segment and for Conversation's Terminal fallback. This is a
remaining platform gap, not a change to the cross-platform product target.

Deferred, with reasons recorded in [Deferred](#deferred): permission-approval cards, offline outbox,
system push and Live Activities, multiple hosts, file editing, image attachments, `@file` and
`/command` completion, voice beyond the system keyboard, light theme, and iPad keyboard shortcuts.

## Connectivity

The implemented encrypted frame, subscription, and heartbeat contract is documented in
[Mobile transport](TRANSPORT.md).

- Accepted gateway addresses are private IPv4 (RFC1918), loopback, and Tailscale IPv4
  (`100.64.0.0/10`). The Server, pairing link, and client apply the same classifier. Tailscale IPv6
  and MagicDNS hostnames are deferred.
- Pairing advertises every eligible address, Tailscale first when present because it survives Wi-Fi
  changes. A relayed Tailscale path (DERP) is acceptable: WireGuard keeps it encrypted end to end and
  the Caxri frame encryption still applies.
- Connect to candidate addresses in parallel, keep the first socket that opens, close the rest, and
  only then send the handshake. A pairing handshake is single-use and must never be raced.
- Foreground recovery: when the app returns to the foreground, probe the current connection. If the
  app was in the background for more than 10 seconds or the probe fails, open a new connection at
  once instead of waiting for the backoff timer. Android vendors such as HyperOS cut background
  sockets aggressively, so foreground recovery is the primary path, not an edge case.
- While in the background, stop all polling and subscriptions.
- A connection becomes stale after five seconds without a valid server observation. Stale content
  stays visible; every mutation is disabled with its reason. Remove the stale banner as soon as a
  fresh authenticated observation arrives. Never clear the last valid view during reconnect.
- Version mismatch is a terminal state, not a retry loop. Copy: `Update required` /
  `This app and Caxri on your computer use different versions. Update both to the latest build.`

### Recovery budget

On a healthy network, returning to the foreground shows a fresh (non-stale) Session list within
2 seconds, and a Wi-Fi ↔ Tailscale handoff recovers within 5 seconds without user action.

## Authority

The implemented device grants, method matrix, and cancellation behavior are documented in
[Mobile authorization](AUTHORIZATION.md).

- A device grant carries a role: `view`, `reply`, or `control`. Each role maps to an explicit method
  set on the Server; every method additionally checks Project scope, Session ownership, and the
  current Agent or Terminal generation.
- New pairings grant `control` for the selected Projects. An existing device is never silently
  upgraded; pairing again is the upgrade path.
- Sessions created from mobile launch with the same Agent settings Desktop uses (owner decision,
  2026-09-24). The launch policy is enforced in Server Core, never by hiding UI.
- A Terminal take-over, Stop, and new Session are `control` actions. Reading output, the conversation,
  and changes is `view`.
- Revoking a device on Desktop ends its connection, subscriptions, and any Terminal lease
  immediately.

## Navigation

```text
/                         Pairing entry (no paired host)
/h/[hostId]               Session home
/h/[hostId]/s/[sessionId] Session screen (segment: conversation | terminal | changes | panels)
/h/[hostId]/new           New Session
/h/[hostId]/add-project   Add Project (control devices only)
```

Routes carry `hostId` from the start even though only one host is supported, so multiple hosts can be
added without moving screens. Query keys include the same host identity.

## Session home

```text
┌───────────────────────────────┐
│ ● MacBook Pro             ⋮   │  connection dot, host name, menu
│ (All) (caxri) (website) …     │  Project filter chips
├───────────────────────────────┤
│ NEEDS ATTENTION               │
│ [✳] fix-login              ●  │  Agent tile, title, status glyph
│     caxri · 2m                │  Project (omitted when filtered) · age
│ RUNNING                       │
│ [◎] refactor-git           ◌  │
│ RECENT                        │
│ [>_] docs-pass                │
│                         ( + ) │  New Session button
└───────────────────────────────┘
```

- Group order stays `NEEDS ATTENTION`, `RUNNING`, `RECENT`. Unread attention sorts first in its
  group; otherwise newest first with stable identity tie-breaking.
- Rows lead with the Agent's brand glyph and carry one status glyph that mirrors Desktop's Session
  indicator: an amber dot for unread attention, a spinner while running, an alert icon for a
  failure, and nothing once settled. State labels (`Waiting for you`, `Working`, `Failed`,
  `Completed`, `Idle`, `Unknown`) stay in the accessible name instead of the visible row. Do not
  expose provider lifecycle jargon.
- Filter chips list granted Projects in Desktop order; `All` is the default. The choice survives
  navigation within the app session.
- The New Session button sits bottom-right above the system gesture inset.
- The host menu contains `Add Project` (control devices only) and `Forget this computer`.
- Do not reorder rows while the user is touching or scrolling the list; reconcile after the
  interaction ends.
- Empty state: `No Sessions yet` / `Start one here or on your computer.` with a `New Session` action.

## Session screen

```text
┌───────────────────────────────┐
│ ‹ ✳ fix-login          ●  ⋮   │  ⋮ = Mark read
│ (💬 Conversation) (>_) (± 3) (▯)│  icon tabs; only the selected one is labeled
├───────────────────────────────┤
│              segment body     │
├───────────────────────────────┤
│ Message Claude Code…    (↑)   │  composer; (■) Stop while running
└───────────────────────────────┘
```

- Default segment: **Conversation** when the Agent's conversation is available, otherwise
  **Terminal**. Remember the last segment per Session for the app session.
- Segments are icon tabs; the selected tab adds its label, and every tab keeps an accessible name.
  The Changes tab shows the changed-file count as a badge when it is non-zero. A plain shell Session
  with no Agent has no Conversation tab.
- The composer is hidden on Project, and on Terminal for a `control` device, which types through the
  Terminal's own keyboard instead. A `reply` device keeps the composer on Terminal because it is its
  only way to answer.
- Mark read happens automatically when the Session screen is visible and fresh; the menu keeps a
  manual action for accessibility.

### Composer

- One multiline input, 1–6 visible lines, then it scrolls. The Send button is the only way to send:
  the Return key inserts a newline. This keeps Chinese and other IME composition safe.
- Placeholder: `Message <Agent name>` when idle or waiting; `Reply while <Agent name> works` while
  running. Messages are typed into the Primary Agent Terminal and
  submitted with the Terminal's Enter path; what the Agent does with input during a turn is the
  Agent's own behavior, so the UI never promises queuing.
- While the Agent is running and the draft is empty, the Send button becomes **Stop** (square icon,
  danger color, label `Stop Agent`). Stop interrupts only the current Agent endpoint and never sends
  a raw Ctrl-C to a shell.
- The byte counter appears only past 75% of the limit.
- Drafts are kept per Session in memory and survive segment switches, navigation, and reconnects.
- Delivery states:
  - `Sending…` — input disabled, draft kept.
  - Delivered to the Terminal — clear the draft.
  - Failed before reaching the Server — keep the draft, show the reason, allow retry.
  - Unknown (connection dropped after sending) — keep the draft and show `Couldn't confirm delivery.
Check the Terminal before sending again.` Never resend automatically.
- When the connection is stale, the composer keeps the draft and names the disabled reason.

### Conversation

The Server turns the Agent's own conversation record into a read-only timeline. The client never
parses provider files.

- User messages: right-aligned bubbles on the raised surface color, max 85% width.
- Agent replies: full-width Markdown, rendered natively. Code blocks scroll horizontally and never
  wrap; inline code uses the monospace face.
- Tool calls: one row each — icon, verb, and a one-line summary (`Ran npm test`, `Edited
src/auth.ts`), plus duration when known. Consecutive tool calls collapse into one group row (`Ran 4
commands · 12s`). Tapping expands the group; tapping a row opens its bounded detail.
- Thinking is hidden. A turn divider shows the turn's duration.
- Content the Agent's harness injects as a user turn (background task notifications, slash-command
  echoes, local command output) renders as a compact event row — status icon and a short title,
  expandable detail — never as the user's own bubble. Reminder-only turns are hidden.
- Auto-follow new content only while the reader is at the bottom. Otherwise show a round
  jump-to-latest button; never pull the reader down.
- Truncated history starts with `Earlier messages are available on your computer.`
- Unsupported Agents or missing records fall back to Terminal with `Conversation view isn't available
for this Agent. Showing the Terminal.` A plain shell never shows this notice.
- Markdown headings are scaled for a chat bubble (19/17/16/15), not document sizes.

### Terminal

- A live Terminal rendered by xterm inside a WebView whose assets ship with the app. The WebView has
  no network access; the native side owns the authenticated connection and forwards batched output.
- The Terminal fills the segment. Status that must interrupt (loading, stale, stopped, view only,
  errors) floats as a compact chip at the top instead of stacking rows under the output. While the
  phone itself is offline the app-wide `Reconnecting…` banner already explains the frozen frame, so
  the stale chip only appears when the connection is up but Terminal updates stopped.
- **Observe** (default): the Terminal keeps Desktop's columns and rows. Every row always fits the
  height, so the newest line is never hidden. The width scales down to a readable minimum; below
  that the view pans horizontally by drag. Pinch zooms out far enough to show the whole width.
  Observing never resizes the PTY.
- **Take over**: a floating `Take over` button (control devices) resizes the PTY to the phone through
  a Server lease and opens the system keyboard. Tapping the Terminal reopens the keyboard; when the
  keyboard changes the visible size, the lease is re-applied with the new size and the phone resizes
  its own grid to match, because the observer stream carries output only. Leaving the screen,
  backgrounding, disconnecting, or revocation releases the lease on the Server and restores the
  previous size. Any size change the phone did not request (Desktop resize, release, lease expiry)
  resyncs observers so the next snapshot carries the new grid.
- While taken over, the only chrome is one row above the keyboard: a horizontally scrolling key bar
  (`Esc`, `Tab`, `Ctrl` sticky toggle, `↑`, `↓`, `←`, `→`, `1`, `2`, `3`, `Enter`, `Paste`), a keyboard
  toggle, and `Release` (✕). Keys send exact bytes; `Ctrl` applies to the next key, including the
  next typed character.
- Typed characters go straight to the PTY in order. The Terminal keyboard disables IME composition,
  so composed text such as Chinese is sent through the Conversation composer instead.
- Output follows the bottom unless the reader scrolled up; then a round jump-to-latest button
  appears.

### Project

Read-only mirrors of Desktop's right sidebar for the Session's Project: **Files**, **Status**, and
any extension panel, switched by a sub-tab row. Desktop's Git panel is omitted because the Changes
tab already shows the same data. Files browses the Project root (symlinks reached through the root
included) and opens bounded text previews; binary and oversized files say so. Status and extension
panels render the same tree nodes Desktop shows, without running their commands. The Project tab is
available to every role; nothing in it mutates the Project. Offline with nothing cached, it asks the
reader to reconnect instead of showing an empty folder or a spinner.

### Changes

- Header: `3 files changed · +42 −8`, plus a refresh action. Outside a Git repository only the
  empty state shows.
- File rows: status letter (`M`, `A`, `D`, `R`, colored like Desktop's Source Control) with a text
  label for accessibility, path with the file name emphasized, and line counts.
- Tapping a file opens its diff: unified view, monospace, line numbers, horizontal scroll, added and
  removed lines marked by both color and a `+`/`−` gutter. The Git preamble (`diff --git`, `index`,
  `---`/`+++`) is hidden when the patch has hunks. Binary and oversized files show
  `This file is too large or not text. Review it on your computer.`
- An `Ask Agent to commit` chip fills the composer with `Commit the current changes with a clear
message.` The user sends it; nothing is sent automatically.

## New Session

```text
┌───────────────────────────────┐
│ ✕  New Session                │
│ Agent                         │
│ [✳ Claude Code] [◎ Codex]     │  brand glyph chips
│ [𝕏 Grok]        [>_ Shell]    │
│ Project                       │
│ [🔍 Filter Projects        ]  │  only with more than 6 Projects
│ 📁 caxri                    ✓ │
│ 📁 website                    │
│ ┊ + Add Project            ┊  │  control devices only
│ [        Create Session     ] │
└───────────────────────────────┘
```

- Agent comes first so it is visible without scrolling however many Projects exist.
- Only granted Projects are listed, most recently used first. Unavailable Agents are shown disabled
  with a short reason.
- Create opens the new Session screen with the composer focused, so the first instruction is typed
  there. Desktop's selected Session does not change.
- Failures keep the choices and explain the error; the button shows progress while creating.

## Add Project

A `control` device can add a folder from the computer's home directory as a Project. The screen
browses child folders starting at home (hidden folders omitted, Git repositories marked); choosing
`Add` creates the Project through the same path Desktop uses and grants it to this device, so it
appears in the Project filter immediately. Git repositories and folders without subfolders carry an
`Add` action on their row; any other folder is added from the footer after opening it. Folders outside home, including through symlinks, are
rejected by the Server. `view` and `reply` devices never see the entry point.

## Layout

- **Phone**: single list-to-detail flow when the window is narrower than `700dp` or its short side is
  below `600dp`. The short-side rule keeps landscape phones out of the tablet layout.
- **Tablet**: at `700dp` wide with a short side of at least `600dp`, show the Session list at `320dp`
  and the Session screen beside it, separated by one semantic border. Selection uses a left accent
  and accessible selected state, not background color alone.
- **Wide tablet**: at `1100dp` and wider, Changes and Project open as a right pane beside Conversation or
  Terminal instead of replacing them.
- Keep readable text columns at or below `680dp`. Pairing content is capped at `520dp`.
- Foldables (second priority): folding or unfolding keeps the selected Session, segment, drafts, and
  scroll position.
- Use system safe areas on every edge. Primary actions never sit under gesture or navigation insets.

## Type and spacing

- Body text starts at `15sp`; core body copy uses `16sp / 24sp`.
- Screen titles use `22sp`; detail titles use `17sp`; metadata uses `13sp`; compact state labels use
  `11–12sp`. Never disable system font scaling.
- Interactive targets are at least `48dp`, except key-bar keys at `44dp`; primary actions use
  `52–56dp`.
- Base spacing is `4dp`; common gaps are `8`, `12`, `16`, `24`, and `32dp`.

## Color and state

- Use Desktop's canonical Dracula palette from `@caxri/protocol`. Mobile components map those shared
  colors to semantic roles through `useMobileTheme()` instead of copying raw values.
- Follow-system appearance, a light theme, and an in-app appearance switch are deferred until they
  can share one reviewed semantic mapping with Desktop. Native system chrome and the splash
  background stay dark Dracula.
- Body, muted, primary-action, and danger color pairs must retain WCAG AA contrast in automated tests.
- Never rely on color alone. Every status includes a label and, where useful, a shape or icon.
- `loading`, `empty`, `error`, `offline/stale`, and `ready` are first-class states on every remote
  surface. A read that cannot start because the phone is offline says so and offers a way back; it
  never shows a spinner that cannot end (Session deep link, New Session Projects, Project tab).
- A screen that throws renders a generic `Something went wrong` screen with `Try again`. It never
  shows the error message or stack, which can carry Session, path, or Terminal details.

## Accessibility

- Every interactive element has a stable `testID`, an accessibility role, a concise label, and a
  result-oriented hint when the action is not self-evident.
- Decorative marks are hidden from the accessibility tree. Group status icon and label as one
  announcement.
- Support TalkBack traversal in visual order and reduced motion. No state change depends on a
  transient animation.
- Live Terminal output and streaming conversation content are never accessibility live regions;
  background output must not interrupt TalkBack.
- Test default and enlarged text on phone and tablet widths before delivery.

## Client data flow

- One connection owner per host owns retry, backoff, and foreground recovery. Query code never
  retries writes on its own.
- Adopt TanStack Query for request/response views (Session list, Projects, Changes) and migrate the
  dashboard in the same change. Server events are invalidation hints; the authenticated Server
  response is the source of truth.
- Terminal bytes and conversation updates arrive through Server subscriptions and never enter the
  query cache or any durable store.
- Only visible views subscribe or poll. Leaving a screen or backgrounding the app ends its
  subscriptions.
- Nothing remote is persisted to device storage except the device credential in the secure store.

## Performance budgets

- Terminal output is written to xterm in batches, at most once per frame.
- The Session list and Conversation are virtualized.
- Switching segments never blocks input; a busy Terminal cannot stall navigation.

## Pairing

- The first screen says `Pair with Caxri` and `Connect to Caxri running on your computer.` Its two
  actions are `Scan pairing code` and `Paste pairing link`; the footnote points to
  `Settings → Mobile` on the computer. Only buttons that open another screen carry a trailing
  chevron; the scan and paste screens go back through a header chevron.
- Camera access is optional. Refusal keeps paste pairing reachable and never blocks the rest of the
  app.
- Pairing links and one-time secrets are never written to app-owned durable storage. Copy places the
  complete two-minute, single-use link on the system clipboard; persist only the resulting bounded
  device credential in the operating system secure store.
- The client stores the addresses advertised at pairing time. With Tailscale available, the stable
  Tailscale address keeps working across Wi-Fi changes; without it, a changed LAN address requires
  pairing again. Automatic LAN discovery stays deferred.

## Deferred

| Capability                        | Why it waits                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Permission-approval cards         | Hooks do not carry an answerable request identity; mapping buttons to keystrokes is not reliable. Use Terminal. |
| Offline outbox                    | Bounded Agent-submit receipts can remain unknown and do not prove Agent execution; automatic resend is unsafe.  |
| System push and Live Activities   | Requires a push service outside LAN/Tailscale; designed together with notification privacy (#499).              |
| Multiple hosts                    | Routes and query keys already carry `hostId`; the UI waits for demand.                                          |
| File editing, image attachments   | Project panels are read-only; editing belongs on Desktop until the remote-control loop needs it.                |
| `@file` and `/command` completion | Composer polish after the core loop is proven.                                                                  |
| Voice beyond system dictation     | The system keyboard's dictation already works in the composer.                                                  |
| iPad keyboard shortcuts           | Tablet layout ships first; hardware-keyboard behavior follows.                                                  |
