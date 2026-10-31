---
kind: living
status: current
---

# Updating the computer from the phone

A paired phone with the **Control** role can update Caxri on the computer it is paired with:
see the version, check, download, and restart into the new version, without anyone at the
computer. This complements [Mobile updates from Desktop](update.md), where the computer updates
the phone, and reuses the computer's own [Desktop updates](../desktop-updates.md) flow.

## User flow

Settings' **Computer** section shows two rows after **Status**:

- **Caxri**: the computer's version and its last check (`0.0.4 · Up to date`). Tapping it asks the
  computer to check again. While Caxri is closed on the computer it reads **Open Caxri on your
  computer to update it**.
- The update row, only when a newer version exists: **Update computer to X** starts the download,
  **Downloading X on your computer** shows its progress, and **Restart to update to X** opens a
  confirmation.

The confirmation is the phone's version of Desktop's **Restart and Update?** prompt, because
nobody may be at the computer to answer one. It names the running Terminals and Chats the restart
stops, the Sessions whose Agent is still working (at most five titles), and the unsent review
comments it loses. After **Restart and Update**, the row reads **Updating your computer to X…**
until the phone reconnects to the restarted computer.

The phone never installs:

- an update that clears data (`resetsData`): only the computer offers the export first;
- a `manual` install: only the computer can open the DMG;
- while an Editor still has unsaved changes after auto save: the row names how many, and the
  computer reveals the windows that hold them. The computer shows no dialog.

View and Reply devices do not see these rows, and an SSH Host window answers `unsupported`, which
hides them.

## Protocol

Three mobile methods, granted to the Control role only
(`packages/protocol/src/mobile/mobile-desktop-update-contract.ts`):

| Method                          | Effect                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `mobile.desktopUpdate.read`     | The computer's `UpdateState`; `check: true` starts a check first            |
| `mobile.desktopUpdate.download` | Starts the download and answers at once                                     |
| `mobile.desktopUpdate.install`  | Restarts into the confirmed `version`, or answers `blocked` with a `reason` |

A read answers `desktop: 'offline'` when no Desktop holds the lease, `unsupported` for an SSH Host
window, and otherwise `online` with the state. A `ready` state also carries `impact`, read from
`terminal.runningCount` and `gitReview.pending` (review comments fail open to zero).

Server Core relays each step to Desktop Main as the `update` Desktop operation
(`apps/server/src/core/desktop-router.ts`), and Main answers from `UpdateService`
(`apps/desktop/src/main/updates/remote-update.ts`). Two constraints shape it:

- Every step answers at once. A download outlives the Desktop command timeout, so the phone polls
  `read` every two seconds while a check or download is moving and Settings is in front.
- The restart starts only after the reply leaves. The quit flow asks Server Core for running
  work, and an ordinary request issued while the Desktop command is unanswered would queue behind
  it until the timeout. The quit flow then runs with the `remote-update` intent, which skips the
  computer's prompts and cancels only on unsaved editors.

Main checks the restart again before it starts, so a version that changed in between does not
install. A restart that fails leaves the phone on **Updating…** only until its first read over a
later connection, which then shows whatever version the computer reports.
