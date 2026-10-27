---
kind: living
status: current
---

# Desktop updates

Caxri updates itself from GitHub Releases without a Developer ID signature. Discovery, download,
and installation all run in Desktop Main (`apps/desktop/src/main/updates/`); the Renderer only
shows the state and asks for the next step.

## Flow

1. **Check.** Main asks GitHub for the latest release at launch, every six hours, and after a wake
   from sleep (`updates.ts`). A rate-limited answer pauses discovery until GitHub's reset time.
2. **Download in the background.** When a newer release is `available`, the Renderer starts the
   download once per version and app process, unless the user skipped that version or the
   **Check for Updates** dialog is open. Cancelling keeps it cancelled for the rest of the run.
3. **Verify and stage.** Main checks the DMG against the release's SHA-256 file, then, on a packaged
   macOS install it can replace, mounts it and copies the app into `updates/staged/` in the profile.
   The copy must carry the expected version, the installed bundle identifier, and its main
   executable. Only then does the state become `ready` with `installMode: 'restart'`. The SHA-256
   check is the integrity guarantee: release bundles are only linker-signed with no sealed
   resources, so `codesign --verify --strict` rejects even a complete copy.
4. **Restart to Update.** The notification and the dialog offer one button. It runs the quit flow
   with the `update` intent: unsaved editors are confirmed as usual, and running Terminals, Chats,
   other connected clients, or pending review comments raise a single **Restart and Update?**
   prompt. There is no keep-running choice: Server Core is stopped, because a Server from the old
   build would be replaced on the next launch anyway.
5. **Install on quit.** An ordinary quit that stops Server Core also installs a staged update, so
   the next launch is the new version. A quit that keeps tasks running in the background does not
   install, since the old Server keeps running from the old bundle.

## In-place install

Electron's `autoUpdater` (Squirrel.Mac) requires a Developer ID signature, which these ad-hoc
signed builds do not have, so Main swaps the bundle itself (`update-install.ts`). Right before it
exits, Main records `updates/install-pending.json` and starts a detached `/bin/sh` script with
structured arguments. The script waits up to 60 seconds for Main's PID to exit, moves the installed
bundle to `updates/previous/`, moves the staged bundle into its place (restoring the old one if
that fails), records the outcome in `updates/install-result`, and reopens the app for a restart.

A DMG fetched by Main carries no quarantine attribute, so the new bundle opens without a Gatekeeper
prompt. The next launch reads the recorded outcome, logs it, and deletes the record and the old
bundle.

## Fallbacks

The update falls back to the manual flow (`installMode: 'manual'`: open the DMG and drag Caxri
into Applications) when the app is unpackaged, not on macOS, running from a mounted DMG or App
Translocation, in a folder the user cannot write, when staging fails, or when the previous launch
recorded a failed in-place install of the same version. The manual flow keeps the unsigned-app
notice; the restart flow does not need it.

## Diagnostics

`updates.state` logs every state except download progress. `updates.install` logs each install
phase with a closed `outcome`:

| `phase`  | `outcome`                                                                                   |
| -------- | ------------------------------------------------------------------------------------------- |
| `stage`  | `staged`, `stage-failed`, `previous-install-failed`, or the unavailable reason              |
| `launch` | `restart` or `quit`                                                                         |
| `apply`  | `installed`, `missing`, `move-in-failed`, `move-out-failed`, or `timeout`, with `from`/`to` |

`stage` also records `durationMs`. An `apply` outcome other than `installed` is logged as an error.
