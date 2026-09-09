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
profile and survives restart. Muted reminders still enter history with a **Muted** label, but do
not produce a popup or increase the unread count. Muting also marks existing eligible entries
of that type read. A repeated event can make an unmuted, previously read entry unread again.

The center's settings button opens **Settings → Notifications**. Turn **Worktree fallback
reminders** or **Automatic Agent recovery reminders** on to restore that type. The same category
contains **System notifications**, the Agent completion duration threshold, and **Delivery
failure notifications**. These are separate controls: muting a recovery reminder does not
disable native Agent notifications or change recovery itself.

Errors and persistent data-loss notices never offer reminder suppression, even if a caller
attaches a reminder type. The separate delivery failure setting still controls its own producer;
the error rule does not override that setting. Success feedback such as copying normally stays
ephemeral unless the caller explicitly opts into history, supplies a reminder type, or marks the
notice persistent.

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
expiration; closing the menu restores a four-second timeout. History contains no action closures
and cannot replay a popup's immediate action.

## Persistence and retention

`notifications.worktreeFallback` and `notifications.agentRecovery` are independent boolean
settings, both defaulting to `true`. Muting patches only the selected scalar key. The Renderer
waits for a successful Server response before syncing preferences and dismissing active popups
of that type. A failed write leaves the reminders visible and reports **Unable to mute
notifications** through the command error path.

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
[architecture reference](../.agents/skills/project-architecture/references/architecture.md) for
the surrounding process contracts.
