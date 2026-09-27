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
notification. The selected Session keeps its fast Status panel poll; every other Session is
refreshed by a slower delivery watch in Server Core (about every three minutes, every minute while
a check or build is still running) that queries each GitHub repository and branch once per round,
however many Sessions point at it. The watch fetches nothing while delivery failure notifications
are disabled. A failure seen for the first time notifies only when GitHub or Vercel dates it after
Server Core started and within the last 30 minutes, so opening a Session on a branch that broke
last week, or restarting Caxri, does not replay old failures. Success feedback such as copying normally stays
ephemeral unless the caller explicitly opts into history, supplies a reminder type, or marks the
notice persistent.

### Native Agent banner content

A native Agent banner names the Agent first: the title is `<Provider> · <Session title>` (the
provider alone for an unnamed Session) and the subtitle is the Session's Project. A waiting banner
reads **Waiting for your input**. A completed-turn banner shows the Agent's closing reply of that
turn as one plain line of at most 200 characters; when the reply cannot be read within 1.5 seconds
— Grok has no transcript parser, a turn that ended without text, or a missing transcript — it falls
back to **Finished in 3m 12s**.

Desktop Main asks for the summary through the internal `agent.replySummary` method only after every
gate has passed. Server Core reads it on demand through the same bounded transcript projection as
the mobile Conversation and returns it without caching or persisting it; neither side logs it, and
the lifecycle hook bridge still carries no response content. Because the read is asynchronous, the
Session is checked again before showing, and a banner the user has meanwhile seen is dropped with
the `superseded` outcome.

Unsigned and ad-hoc builds deliver through `alerter`, which withdraws a banner after 30 seconds and
draws its icon unmasked, so packaged builds ship `build/notification-icon.png` — the production
icon with the rounded macOS plate baked in — as an extra resource.

## Ownership and event flow

| Owner                                  | Responsibility                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer `stores/toasts.ts` and Sonner | Record eligible history before checking suppression; present live popups and own expiration, actions, and dismissal.                      |
| Renderer `stores/notifications.ts`     | Keep bounded entries, unread state, grouping, and the projection of typed reminder settings in memory.                                    |
| Server settings domain                 | Persist scalar preferences through `settings.patch` in the profile's `settings.jsonc`; return authoritative settings.                     |
| Desktop Main                           | Decide and deliver native Agent notifications; forward only `shown` waiting/completed decisions as transient `agent.notification` events. |
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
time whether the follow-up still applies — a Session that was deleted, a Terminal somebody already
restarted — replacing the button with that reason instead of running it.

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

| Symptom                                     | Inspect                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reminder appears only in history          | Check its typed preference in Settings → Notifications and the row's Muted label. Errors and persistent notices bypass this filter.                                         |
| History disappeared after reload            | Expected memory lifetime; there is no disk archive or replay recovery.                                                                                                      |
| Agent activity has no history entry         | Check the native notification settings and Main's decision outcome first. The center records only forwarded waiting/completed `shown` decisions, not all Agent transitions. |
| Muting fails                                | Follow the `settings.patch` command failure. Do not dismiss the original popup or assume a preference was saved.                                                            |
| A settings shortcut opens the wrong section | Follow `settings.openNotifications` into the settings dialog controller. Its scroll request must remain pending until the virtual list has measured items.                  |
| Delivery failures group incorrectly         | Verify `projectStatus.alert` repository and branch identity before changing general history grouping.                                                                       |

Implementation entry points are
[`stores/notifications.ts`](../apps/desktop/src/renderer/src/stores/notifications.ts),
[`stores/toasts.ts`](../apps/desktop/src/renderer/src/stores/toasts.ts),
[`stores/workbench.ts`](../apps/desktop/src/renderer/src/stores/workbench.ts), and
[`agent-notification-runtime.ts`](../apps/desktop/src/main/agent-notification-runtime.ts).
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
