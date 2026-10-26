---
kind: living
status: current
---

# Troubleshooting

## macOS says Caxri is "damaged" or blocks it

Caxri is unsigned and unnotarized, so Gatekeeper may refuse the first launch. After verifying the
download against its `.sha256` file, either run

```bash
xattr -dr com.apple.quarantine /Applications/Caxri.app
```

and open it again, or open **System Settings → Privacy & Security**, find the message about Caxri,
click **Open Anyway** and confirm.

## No notifications appear

1. Open **Settings → Notifications → System notifications**. It shows the helper status.
2. If the helper is missing, run `brew install vjeantet/tap/alerter`, then choose **Check Again**.
3. Choose **Send Test Notification**. If no banner appears, open **System Settings → Notifications**
   and allow notifications for the entry named "alerter".
4. Fully quit and reopen Caxri if the helper was installed while it was running.

## Agent not found

Caxri runs your installed Agent CLI; it does not bundle one. Install the CLI and confirm it works in
Terminal, then in **Settings → Agents** open the Agent and set **Executable** to its full path (for
example the output of `which claude`). Restart the Agent Terminal afterwards.

## Caxri couldn't start its background service

Choose **Try Again**. If the message returns, choose **Help → Reveal Logs in Finder** to open the
log folder and **Export Diagnostics** to save a report you can attach to an issue. Quitting
Caxri fully and reopening it also clears most stuck starts.

## Where the data and logs live

The profile (database, settings) is in `~/Library/Application Support/Caxri`; logs are in its
`logs` folder. **Help → Reveal Logs in Finder** opens it. Diagnostics never include source
contents, Terminal output or Agent transcripts.

## Reset Caxri

Quit Caxri, then move `~/Library/Application Support/Caxri` to the Trash. The next launch starts
fresh. Your Project folders are never touched. To remove Agent hook entries and the Claude
window background job (on by default for Claude Pro) first, turn those features off in Settings. If you
installed the `caxri` command, run **Uninstall 'caxri' Command from PATH** from the command palette,
or delete the `/usr/local/bin/caxri` symlink with `sudo rm /usr/local/bin/caxri`; the README's
[Uninstall and reset](../README.md#uninstall-and-reset) section lists everything Caxri changes.

## Report a problem

Choose **Help → Report an Issue**, describe what you did and expected, and attach the file from
**Help → Export Diagnostics**. The version is under **Caxri → About Caxri**.
