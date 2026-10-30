---
kind: living
status: current
---

# Notifications

Caxri's notification center lets users revisit recent reminders and failures after a popup
disappears. Repeated worktree fallback and automatic Agent recovery reminders can be muted by
type and restored from one settings category. This is a recent activity view for the current
window, not a persistent archive or a complete Agent activity log.

## User flow

When an unavailable worktree returns to its Project, the ordinary reminder lasts four seconds.
The Status Bar bell opens its retained entry in **Notifications**, alongside other retained
reminders and failures. Opening the center marks all entries read; new entries while it is open
are also read. Users can remove one entry or clear the list without changing their preferences.

Eligible popups expose **Don't show this type again** in their options menu; eligible history
rows offer the same action. The preference applies to all Projects served by the current Server
profile and survives restart. Muted reminders still enter history, but do not produce a popup
or increase the unread count. The **Muted** label reflects the type's current preference on all
eligible rows, including older entries; it does not record whether an event originally showed a
popup. Restoring the preference removes that label. Muting also marks existing eligible entries
of that type read. A repeated event can make an unmuted, previously read entry unread again.

While Zen Mode is on, `info`, `success`, and `warning` notices with no follow-up button and no
`persist` flag do not pop up, because Zen is for attention. They are still recorded under the usual
history rules and show as unread on the status bar bell once Zen ends; nothing replays. Failures,
persistent notices, and any notice offering a follow-up button keep popping up. Entering Zen closes
the center, since the bell that owns it is hidden.

The center's settings button opens **Settings → Notifications**. Turn **Worktree fallback
reminders** or **Automatic Agent recovery reminders** on to restore that type. The same category
contains **System notifications**, **Completed turn threshold**, and **Delivery
failure notifications**. These are separate controls: muting a recovery reminder does not
disable native Agent notifications or change recovery itself.

Errors and persistent data-loss notices never offer reminder suppression, even if a caller
attaches a reminder type. The separate delivery failure setting still controls its own producer;
the error rule does not override that setting. Disabling delivery failure notifications prevents
those alerts from being emitted, including their history entries.

Delivery failure alerts cover every unarchived Session, not only the selected one: a failing CI
check, a failing Vercel preview build, or a failing Vercel production build raises one
notification. Every Session a visible window shows keeps its fast Status panel poll; every other Session is
refreshed by a slower delivery watch in Server Core (about every three minutes; a Session whose own check or build is still running is revisited every
minute, without pulling settled Sessions along) that queries each GitHub repository and branch once per round,
however many Sessions point at it. The watch fetches nothing while delivery failure notifications
are disabled. A failure seen for the first time notifies only when GitHub or Vercel dates it after
Server Core started and within the last 30 minutes, so opening a Session on a branch that broke
last week, or restarting Caxri, does not replay old failures. Success feedback such as copying normally stays
ephemeral unless the caller explicitly opts into history, supplies a reminder type, or marks the
notice persistent.

### Environment monitoring

**Settings → Notifications** also configures three independent environment signals. **Public IP
changes** is on by default and compares the current public egress address with the first successful
lookup in this Desktop launch. Caxri reads the address from the fixed neutral endpoint
`https://api.ipify.org?format=json`; users who need this reading to represent an Agent's route
should send that host through the same Clash or Mihomo node as the Agent. **Expected system time
zone** is off until the user selects one IANA time zone, then compares that exact expectation with
the system time zone.

The **Environment** Workbench page opens from the **Open Environment** command or by clicking the
Status Bar warning. It shows the current public IP, IP version, country and region, ASN, ISP,
organization, network type, the provider's 0–100 risk score, and its separate anonymous, hosting,
proxy, VPN, Tor, compromised, and scraper observations. The score is labeled as third-party risk,
where a higher value means the provider observed more risk signals; it is not renamed or inverted
into a universal purity rating. The public IP is the value returned by ipify. Caxri asks the fixed
`checkip.me/<observed-ip>` endpoint to enrich that exact address on the initial reading, an address
change, or a manual check; an enrichment request routed through a different node therefore cannot
replace the monitored exit with the enrichment provider's caller address. Provider fields are
third-party observations, not a universal IP purity score or a conclusion about another service.
The provider documents that explicit-IP results may be cached for up to 30 days. Unavailable
enrichment never stops public-IP change detection.

**Domain routes through Mihomo** is also off until at least one exact domain-to-node assertion is
added. It accepts only a local loopback HTTP Controller or an absolute Unix socket. Node choices
come from the Controller's proxy list; route checks read the Controller's existing live connections
and compare the latest matching connection chain with the chosen node. Caxri does not request the
configured domain to test its route. No matching connection is no evidence, and an unavailable
Controller or failed public-IP lookup is not itself an environment warning.

An enabled signal with contrary evidence raises a generic native notification and keeps an
**Environment warning** item in the Status Bar until the evidence clears or the expectation is
disabled. Hovering that item lists only the concrete active warnings; clicking it opens the full
Environment page. **Check Now** refreshes the report. When the public IP changed, **Use Current IP**
adopts the latest successful address as this launch's new baseline without clearing time-zone or
route warnings.

The address, enrichment response, baseline, and route observations are transient local state. They
are not persisted, logged, included in diagnostics, or copied into native notification content.
They cross the local Main-to-Renderer request boundary only while rendering the Environment page.

### Native Agent banner content

A native Agent banner names the Agent first: the title is `<Provider> · <Session title>` (the
provider alone for an unnamed Session) and the subtitle is the Session's Project. A waiting banner
reads **Waiting for your input**. A completed-turn banner shows the Agent's closing reply of that
turn as one plain line of at most 200 characters; when the reply cannot be read within 1.5 seconds
(Grok has no transcript parser, a turn that ended without text, or a missing transcript) it falls
back to **Finished in 3m 12s**.

Desktop Main asks for the summary through the internal `agent.replySummary` method only after every
gate has passed. Server Core reads it on demand through the same bounded transcript projection as
the mobile Conversation and returns it without caching or persisting it; neither side logs it, and
the lifecycle hook bridge still carries no response content. Because the read is asynchronous, the
Session is checked again before showing, and a banner the user has meanwhile seen is dropped with
the `superseded` outcome.

Unsigned and ad-hoc builds deliver through `alerter` (the notification helper), which withdraws a
banner after 30 seconds and draws its icon unmasked, so packaged builds ship
`build/notification-icon.png` (the production icon with the rounded macOS plate baked in) as an
extra resource.

### Delivery modes and the notification helper

Main picks a delivery mode for every banner from two inputs: whether the running app is signed
(probed once per launch) and whether `alerter` can be found. The lookup tries
`/opt/homebrew/bin/alerter`, `/usr/local/bin/alerter`, then the login shell's PATH. A found helper is
kept for the process; a miss is trusted for 60 seconds and then looked up again, so a helper
installed while Caxri runs takes effect on a later banner without a restart. A failed spawn also
forgets the cached path.

| Mode        | When                                          | Click focuses the Session |
| ----------- | --------------------------------------------- | ------------------------- |
| `native`    | Signed build (and E2E launches)               | Yes                       |
| `alerter`   | Unsigned build, helper found                  | Yes                       |
| `osascript` | Unsigned build, helper missing (basic banner) | No                        |

The `osascript` fallback runs `/usr/bin/osascript` with a fixed script and passes the title,
body, and subtitle as separate argv items, so notification text never becomes script source.
Control characters are flattened to spaces and each field is capped at 1,000 characters.

Main logs `agent_notifications.delivery_fallback` with a closed `mode` and `reason`
(`unsigned_build`, `unsigned_build_no_helper`) on each change of mode, not per banner. A failed
basic banner logs `agent_notifications.operation_failed` with `osascript_failed`; the first one per
launch also raises the transient `notifications.helperUnavailable` event, which the Renderer turns
into one warning toast pointing at **Settings → Notifications**.

**Settings → Notifications → System notifications** shows the current mode in plain words
(`Delivered by the notification helper`, `Notification helper not installed. Install it with:` plus a
Copy button for `brew install vjeantet/tap/alerter`, or `Delivered by macOS notifications` for a
signed build). **Check Again** forces a fresh helper lookup (`notifications.helperStatus` with
`recheck`). **Send Test Notification** (`notifications.sendTest`) sends a generic banner with no
Session content and reports only that it was handed to the backend; Focus modes and the per-app
macOS switch can still hide it. **Open macOS Notification Settings**
(`notifications.openSystemSettings`) opens System Settings at its Notifications pane. The
description of the **System notifications** setting notes that lifecycle hooks are needed only for
Agents running in Terminals, not for Chats.

## Ownership and event flow

| Owner                                  | Responsibility                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer `stores/toasts.ts` and Sonner | Record eligible history before checking suppression; present live popups and own expiration, actions, and dismissal.                      |
| Renderer `stores/notifications.ts`     | Keep bounded entries, unread state, grouping, and the projection of typed reminder settings in memory.                                    |
| Server settings domain                 | Persist scalar preferences through `settings.patch` in the profile's `settings.jsonc`; return authoritative settings.                     |
| Desktop Main                           | Decide and deliver native Agent notifications; forward only `shown` waiting/completed decisions as transient `agent.notification` events. |
| Desktop Main environment monitor       | Keep the launch-scoped public-IP baseline, evaluate selected expectations, read local Mihomo metadata, and deliver generic warnings.      |
| Project Status alert path              | Emit `projectStatus.alert` for delivery failures; Renderer records the received alert without another popup.                              |

`agent.notification` carries only `sessionId` and `attentionKind`. Renderer resolves the current
Session and Project display names from bootstrap state and constructs the history message.
It records the event directly instead of calling `pushToast`, so the native banner does not
also generate a Renderer popup. The event reflects the delivery coordinator's `shown` outcome,
not proof that the user saw the operating system banner. Suppressed or failed deliveries do not
generate this history event. Both event types are transient and excluded from journal replay,
so reconnecting does not backfill missed notifications.

Sonner remains the sole live toast queue. Opening a reminder's portaled options menu pauses its
expiration; closing the menu restores a four-second timeout. History still contains no closures: a
popup's action is recorded as the name of a follow-up plus the plain data needed to replay it
(`stores/toast-actions.ts` owns the closed set and its labels; `commands/toast-actions.ts` owns what
each one does). The center rebuilds the same button from that record, and asks the handler at click
time whether the follow-up still applies (a Session that was deleted, a Terminal somebody already
restarted) replacing the button with that reason instead of running it.

## Persistence and retention

`notifications.worktreeFallback` and `notifications.agentRecovery` are independent boolean
settings, both defaulting to `true`. Muting patches only the selected scalar key. The Renderer
waits for a successful Server response before syncing preferences and dismissing active popups
of that type. A failed write leaves the reminders visible and reports an error through the command
error path. The displayed text can be the Server's error message; **Unable to mute notifications**
is the command's diagnostic label, not a guaranteed prefix for every failure.

History uses an ordinary Zustand memory store with no persistence middleware:

- At most 100 entries, ordered by the latest occurrence; oldest entries are evicted.
- Messages retain at most 4,096 JavaScript string code units; Project titles retain at most 256.
- Exact repeats group by kind, bounded message, reminder type, Project identity, and persistent
  flag. Their timestamp advances and occurrence count caps at 999.
- Delivery failures use repository plus branch as their grouping identity, so identical failure
  names on different branches remain separate.
- Reloading or closing the window clears its history and unread state. Restart restores settings,
  not history. Removing entries never alters the underlying event or the muted preferences.

The recorder explicitly copies its supported fields instead of retaining the caller's object.
Message bodies and action closures are not written to disk or diagnostic logs by this history
path. `persist` on a toast means it stays visible until dismissed; it does not mean disk storage.
History must not become a vehicle for retaining source content, Terminal output, or Agent transcripts.

## Troubleshooting and maintenance

| Symptom                                     | Inspect                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reminder appears only in history          | Check its typed preference in Settings → Notifications and the row's Muted label. Errors and persistent notices bypass this filter.                                                                                                                                                                        |
| History disappeared after reload            | Expected memory lifetime; there is no disk archive or replay recovery.                                                                                                                                                                                                                                     |
| No banner appears on an unsigned build      | Open Settings → Notifications → System notifications: install the helper and press Check Again, then Send Test Notification. If the test is sent but nothing shows, check macOS notification settings and Focus mode. Look for `agent_notifications.delivery_fallback` and `osascript_failed` in the logs. |
| Agent activity has no history entry         | Check the native notification settings and Main's decision outcome first. The center records only forwarded waiting/completed `shown` decisions, not all Agent transitions.                                                                                                                                |
| Muting fails                                | Follow the `settings.patch` command failure. Do not dismiss the original popup or assume a preference was saved.                                                                                                                                                                                           |
| A settings shortcut opens the wrong section | Follow `settings.openNotifications` into the settings dialog controller. Its scroll request must remain pending until the virtual list has measured items.                                                                                                                                                 |
| Delivery failures group incorrectly         | Verify `projectStatus.alert` repository and branch identity before changing general history grouping.                                                                                                                                                                                                      |

Implementation entry points are
[`stores/notifications.ts`](../apps/desktop/src/renderer/src/stores/notifications.ts),
[`stores/toasts.ts`](../apps/desktop/src/renderer/src/stores/toasts.ts),
[`stores/workbench.ts`](../apps/desktop/src/renderer/src/stores/workbench.ts), and
[`agent-notification-runtime.ts`](../apps/desktop/src/main/notifications/agent-notification-runtime.ts).
Setting labels and defaults live in
[`settings-spec.ts`](../packages/protocol/src/configuration/settings-spec.ts); transient event
classification lives in
[`event-journal.ts`](../packages/protocol/src/transport/event-journal.ts).

For a future behavior change, keep grouping, bounds, suppression, and write-failure regressions
at the store/command boundary. Use focused Electron workflows for the bell, reminder menu,
restore setting, and virtualized settings navigation, then visually verify UI changes under the
repository's desktop workflow. See [DESIGN.md](../DESIGN.md) for presentation rules and the
[product model](../.agents/skills/project-architecture/references/product-model.md) for
the surrounding process contracts.
