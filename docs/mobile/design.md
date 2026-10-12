---
kind: living
status: current
---

# Caxri Mobile Design

## Purpose

Caxri Mobile is a remote control for Agent Sessions running on the owner's own computer. Over the
local network or Tailscale, the owner can see which Session needs them, read the Agent conversation,
watch and drive the live Terminal, send instructions, stop an Agent, start a new Session, and review
the resulting changes.

The mobile Project panel supports bounded text-file edits. Settings and multi-pane Terminal layouts
stay on Desktop.

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
  (Files, Status, and extension panels, mirroring Desktop's right sidebar).
- Composer with image attachments, `/` actions, `@` file completion, and a Stop action.
- Claude Code permission and question cards in Conversation, scoped to the exact blocking hook.
- Creating a Session in a granted Project, and adding a Project from a `control` device.
- Phone layout plus a tablet split layout.

Current implementation boundary: live Terminal observation and control are Android-only. iOS
shows an unavailable state for this segment and for Conversation's Terminal fallback. This is a
remaining platform gap, not a change to the cross-platform product target.

Deferred, with reasons recorded in [Deferred](#deferred): offline outbox, system push and Live
Activities, multiple hosts, voice beyond the system keyboard, light theme, and iPad keyboard
shortcuts.

## Connectivity

The implemented encrypted frame, subscription, and heartbeat contract is documented in
[Mobile transport](transport.md).

- Accepted gateway addresses are private IPv4 (RFC1918), loopback, and Tailscale IPv4
  (`100.64.0.0/10`). The Server, pairing link, and client apply the same classifier. Tailscale IPv6
  and MagicDNS hostnames are deferred.
- Pairing advertises every eligible address, Tailscale first when present because it survives Wi-Fi
  changes. A relayed Tailscale path (DERP) is acceptable: WireGuard keeps it encrypted end to end and
  the Caxri frame encryption still applies.
- Connect to candidate addresses in parallel, keep the first socket that opens, close the rest, and
  only then send the handshake. A pairing handshake is single-use and must never be raced.
  React Native Android ignores `close()` on a socket that is still connecting
  ([react-native#35554](https://github.com/facebook/react-native/issues/35554)), so a losing,
  timed-out, or cancelled socket that opens late is closed again at that point and never carries a
  hello. Otherwise it idles until Server's handshake deadline and counts as a false
  `handshakeTimeout`.
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
[Mobile authorization](authorization.md).

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
- On a control device, swiping a row left reveals its `Archive` action. At most one row shows its
  action: starting to swipe another row, tapping a different row, or scrolling the list closes the
  open row, and the tap that closes a row does not open that Session. Android Acceptance
  `MOB-MOTION-02` records this.
- Empty state: `No Sessions yet` / `Start one here or on your computer.` with a `New Session` action.

## Session screen

```text
┌───────────────────────────────┐
│ ‹ ✳ fix-login          ●  ⋮   │  ⋮ = Mark read
│ (💬 Conversation) (>_) (± 3) (▯)│  icon tabs; only the selected one is labeled
├───────────────────────────────┤
│              segment body     │
├───────────────────────────────┤
│ Message Claude…         (↑)   │  composer; (■) Stop while running
└───────────────────────────────┘
```

- Default segment: **Conversation** when the Agent's conversation is available, otherwise
  **Terminal**. Remember the last segment per Session for the app session.
- Segments are icon tabs; the selected tab adds its label, and every tab keeps an accessible name.
  The Changes tab shows the changed-file count as a badge when it is non-zero. A plain shell Session
  with no Agent has no Conversation tab.
- A Project view tab shows the icon its container declares, resolved through the same glyph table as
  Desktop's secondary-sidebar tabs (`viewContainerIconGlyph` in `@caxri/protocol`), so Files and
  Status keep their Desktop glyphs. A container the phone cannot draw (an extension image, which the
  Server does not project, or an unknown id) shows one generic package glyph, never Status's.
- Switching segments slides the new body in from the side the selection moved toward while it fades
  in; the first segment of a Session does not move because the screen transition already animates
  it. A populated Conversation stays hidden until its list has scrolled to the latest message, so it
  plays the slide itself once it is positioned instead of spending it on an empty frame. Android
  Acceptance `MOB-MOTION-01` reads the entry side of every switch from its recording.
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
  danger color, label `Stop Agent`). Send and Stop are the composer's primary action at `52dp`, and
  the one-line input matches that height. Stop interrupts only the current Agent endpoint and never sends
  a raw Ctrl-C to a shell.
- The byte counter appears only past 75% of the limit.
- Drafts are kept per Session in memory and survive segment switches, navigation, and reconnects.
- The attach button opens an image source sheet. A choice slides the sheet away first and only then
  opens the photo picker or camera, so system UI never covers a sheet still on screen
  (`MOB-COMPOSE-02`). A Chat composer offers the same sheet and strip, for up to 4 images, when the
  provider takes images in a Chat (Claude Code and Codex); an image alone is a valid message
  (`MOB-CHAT-05`). For a provider that does not (Grok Build) the attach button stays visible but
  disabled, and tapping it explains why (`Grok Build can't read images in a Chat.`). A sent image opens full screen; when the provider's record has
  no original (always for Codex) the viewer shows the thumbnail and says `Showing a preview. The
full-size image is not available.` (`MOB-CHAT-07`), and with neither it says `This image is no
longer available.` without a Retry (`MOB-CHAT-08`).
- Delivery states:
  - `Sending…`: input disabled, draft kept.
  - Delivered to the Terminal: clear the draft.
  - Failed before reaching the Server: keep the draft, show the reason, allow retry.
  - Unknown (connection dropped after sending): keep the draft and show `Couldn't confirm delivery.
Check the Terminal before sending again.` Never resend automatically.
- When the connection is stale, the composer keeps the draft and names the disabled reason.
- A Chat's composer carries one row above the input naming the model and reasoning effort of the
  next turn (`Fake Codex · High`), with Desktop's names. The row is `40dp` tall with a hit slop that
  makes it a `48dp` target. Tapping it opens a sheet with `Model` and
  `Reasoning effort` lists that apply on tap and a `Done` button; the sheet stays open after a
  model is chosen so its efforts show right away. While a turn runs the sheet says `Applies from
the next turn.` Without access or a connection the row is plain text, and an open sheet disables
  its lists and names the reason. A new Chat opens with this row, so the model is chosen before the
  first message. A change the provider refuses keeps the current choice checked and shows Desktop's
  `Unable to switch the model.` with `Try again.` in the sheet (`MOB-CHAT-09`). See
  [Agent Chat](../agent-chat.md#mobile).

### Conversation

The Server turns the Agent's own conversation record into a read-only timeline. The client never
parses provider files.

- User messages: right-aligned bubbles on the raised surface color, max 85% width.
- Agent replies: full-width Markdown, rendered natively. Code blocks scroll horizontally and never
  wrap; inline code uses the monospace face.
- Tool calls: one row each: icon, verb, and a one-line summary (`Ran npm test`, `Edited
src/auth.ts`), plus duration once it reaches a second; a sub-second duration is never shown, on a
  row, a group, or a turn. Consecutive settled tool calls collapse into one group row (`Ran 4
commands · 12s`); a failed member puts a failure glyph on the group. Tapping expands the group;
  tapping a row opens its bounded detail. A tool still running stays out of the group as its own
  row: it keeps its glyph (no spinner) and reads as one line, the present-tense verb and subject
  (`Running pnpm test`), under a highlight that sweeps across it every 2.2 s, Desktop's
  `.activity-shimmer`. Reduced motion leaves the line static.
- Tool detail opens in a bottom sheet capped at 65% of the screen height. Its title and `Close` stay
  in place while long output scrolls inside the sheet (`MOB-MOTION-03`).
- A terminal Agent's thinking is hidden. A turn divider shows the turn's duration (`Worked for 2m
1s`, or `Worked` under a second).
- A Chat draws Desktop's Chat timeline in the same list. Reasoning is a `Thinking` row while it
  streams and a `Thought` row after, titled by its latest bold heading; its detail is the text.
  Work rows follow Desktop's: a change shows `+N -M`, a command shows a `Background` tag and a
  non-zero `Exit N`, and a step that failed, was declined, or was interrupted shows its own glyph.
  A command's detail is titled by the Agent's description when there is one and shows the command
  highlighted as shell, then its output highlighted by what printed it (a diff, JSON, or a file's
  language) in a box capped at 320dp that scrolls, `Exit code N`, and the background note. A
  change's detail lists each file with its colored status letter, `+N -M`, and a diff that scrolls
  sideways. A finished turn ends under its final reply with what it left behind: an `Edited
<file>` or `Edited N files` card that expands to every file's diff, and a card for each pull
  request, issue, or acceptance report the Agent filed that opens it in the browser. Its work and
  commentary fold behind a `Worked for X`, `Failed after X` (danger), or `Stopped after X`
  (warning) row over a hairline, placed where the work began; a tap shows or hides them, and a
  running turn never folds. The Agent's plan
  is a one-row card above the composer (`Plan`, the current step, a segment per step, `2/5`) that
  expands to its steps. The line above the composer says what the Chat is doing with Desktop's
  words under the same sweep (`Pondering…`, `Compacting context…`) and, after a second, how long
  the turn has run; waiting on the user shows a still question glyph in the warning color instead.
- Content the Agent's harness injects as a user turn (background task notifications, slash-command
  echoes, local command output) renders as a compact event row: status icon and a short title,
  expandable detail, never as the user's own bubble. Reminder-only turns are hidden.
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
- **Observe** (default): the Terminal keeps Desktop's columns and rows. The default scale has a
  readable minimum; a tall grid scrolls vertically and starts at the latest output. A wide grid
  pans horizontally. Pinch zoom can shrink the view to fit the whole grid.
  Observing never resizes the PTY.
- **Scrolling**: a vertical drag scrolls xterm's own scrollback for a normal-screen shell. An
  alternate-screen or mouse-reporting application, such as a full-screen Agent TUI, `vim`, or `less`,
  keeps no xterm scrollback, so on a control device the drag is forwarded as wheel input through
  `mobile.terminal.scroll`, the same way a Desktop wheel reaches the application. This scrolls the
  shared screen that Desktop also shows, and needs no takeover. View and reply devices scroll only
  local scrollback and never send `mobile.terminal.scroll`.
- One displayed row of finger travel sends one wheel line, so an application that moves one line per
  wheel step follows the finger; a flick released while moving keeps gliding. Android Acceptance
  `MOB-TERM-SCROLL-FEEL-01` measures this against a synthetic full-screen application for both SGR
  wheel reports and cursor-key scrolling.
- **Take over**: a control device takes the lease automatically once the Terminal is ready and the
  phone grid size is known, without raising the keyboard. The automatic attempt happens once per
  subscription. A floating `Release` button hands the size back, and a released Terminal stays
  released (including across resubscribe and network recovery) until the reader leaves the Terminal.
  View and reply devices stay watch-only. The floating `Take over` button (shown while released)
  resizes the PTY to the phone through a Server lease and opens the system keyboard. The phone keeps the text size it showed while
  observing, so the leased grid holds as many cells as fit at that size instead of switching to a
  large full-size font. Pinching while leased changes the text size, and the lease is then re-applied
  at the new grid so the content reflows to fill the phone. Desktop mirrors the leased grid until
  release. Because the phone types through a native input, the WebView never holds focus; while
  leased it jumps to the latest output and draws a blinking block cursor itself instead of xterm's
  unfocused outline. Tapping the Terminal reopens the keyboard; when the
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
│ [✳ Claude]      [◎ Codex]     │  brand glyph chips; catalog displayName
│ [𝕏 Grok Build]  [>_ Shell]    │
│ Open as                       │  Chat-capable Agents only
│ [💬 Chat]       [>_ Terminal] │
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
- The Project starts on the Session list's selected Project chip, or the most recently used Project
  under `All`; a Project picked here wins until another chip is chosen. When the new Session lands in
  a Project other than the selected chip, the chip moves to that Project so the list shows it.
- `Open as` picks the new Agent's surface. It defaults to the computer's `Open Agents in Chat`
  setting, a pick here applies only to this screen and never writes that setting, and it is hidden
  for Shell, which always opens in a Terminal. A Chat streams its reply as it is written; a Terminal
  Agent's Conversation updates block by block from the Agent transcript.
- Create opens the new Session screen. A Terminal Session focuses the composer, so the first
  instruction is typed there; a Chat Session opens its Agent Chat view. Desktop's selected Session
  does not change.
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
  `52–56dp`. The composer's Send and Stop are `52dp`; approval, question, and request buttons and
  their options are `48dp`.
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

## Testing position

- Pure cryptography, frame replay protection, protocol projection, sorting, reconnect state,
  parsing, and policy checks run in Vitest without React Native mocks.
- The guarded Android acceptance test launches the real Desktop and Server with a fake Agent, pairs
  through the encrypted gateway, taps only stable `testID` controls, and proves the exact bounded
  PTY write and resulting state transition.
- Device receipts contain only stable identifiers, enabled/clickable flags, counts, and timings.
  They exclude visible copy, source, Terminal output, Agent transcripts, credentials, and
  environment data.
- Android and iOS native builds are both exercised locally. Android currently owns the automated
  interaction path because ADB offers explicit device selection and deterministic system control.

## Client data flow

- One connection owner per host owns retry, backoff, and foreground recovery. Query code never
  retries writes on its own.
- Adopt TanStack Query for request/response views (Session list, Projects, Changes) and migrate the
  dashboard in the same change. Server events are invalidation hints; the authenticated Server
  response is the source of truth.
- Terminal bytes and conversation updates arrive through Server subscriptions and never enter the
  query cache. Only the bounded [read cache](#read-cache) below keeps a copy on the device.
- Only visible views subscribe or poll. Leaving a screen or backgrounding the app ends its
  subscriptions.
- The device credential lives in the secure store. Apart from it, only the read cache persists
  remote data on the device.

### Read cache

A cold start or a phone without a connection shows what the phone last read instead of a spinner:
the Session list, and the newest messages of recently opened Conversations and Chats. It is a read
cache only; nothing is sent from it (see the offline outbox under [Deferred](#deferred)).

- Each saved copy is labeled: `Showing Sessions saved 5m ago.` above the list and
  `Showing messages saved 5m ago.` at the top of a Conversation or Chat, above any state notice.
  The app-wide `Reconnecting…` banner and every disabled mutation keep explaining why it is not
  live. While the screen below labels its saved copy, the banner's body reads only `Replies are
paused until Caxri reconnects.` instead of repeating `Showing the last known state.`
- The first live read replaces the saved copy as a whole; the label disappears with it. A saved
  copy is never merged into live history, because it has no cursor into it.
- What is kept: the Session dashboard as the Server returned it, and per Conversation or Chat the
  newest 50 items, for at most 20 Conversations and Chats (least recently saved go first).
  Conversation tool and system-event details, Chat command and tool output, file diffs, image
  previews, and pending approvals or questions are dropped before writing: like diagnostics, the
  cache keeps no Terminal output or source. It never holds the device credential, pairing links,
  or any key. A saved Chat keeps the model in use, so the composer names it as Desktop does, and
  keeps each image's place as an empty tile until the connection returns and the thumbnail loads.
- Entries are files in the app's private document directory, each tagged with the pairing scope
  (host, device, generation) that read it. An entry from another scope or an older format reads as
  a miss. Forgetting the computer, a revoked device, and a new pairing delete the whole cache, and a
  write still pending at that moment is dropped.
- Writes trail the live view by one second and flush when the app goes to the background. Every
  read or write failure counts as a miss, so a broken file never blocks the live view.

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

| Capability                      | Why it waits                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline outbox                  | Bounded Agent-submit receipts can remain unknown and do not prove Agent execution; automatic resend is unsafe. The [read cache](#read-cache) shows saved content but never sends. |
| System push and Live Activities | Requires a push service outside LAN/Tailscale; designed together with notification privacy (#499).                                                                                |
| Multiple hosts                  | Routes and query keys already carry `hostId`; the UI waits for demand.                                                                                                            |
| Voice beyond system dictation   | The system keyboard's dictation already works in the composer.                                                                                                                    |
| iPad keyboard shortcuts         | Tablet layout ships first; hardware-keyboard behavior follows.                                                                                                                    |

## Open verification gates

- Release-build startup and frame benchmarks on at least one Android phone-class device and one iOS
  simulator/device, with app-owned first-interactive instrumentation.
- Sleep/wake, network handoff, and reconnect coverage before background notifications.
- A device automation layer such as Maestro only when a second critical native workflow justifies
  another dependency and its installation is explicitly approved.
