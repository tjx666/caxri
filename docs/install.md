---
kind: living
status: current
---

# Install Caxri with a coding agent

This page is written for a coding agent (Claude Code, Codex, Grok Build, or similar) installing
Caxri on its user's Mac. A person can follow the same steps by hand. The README's one-line
instruction points here:

> Install Caxri for me by following
> <https://raw.githubusercontent.com/tjx666/caxri/main/docs/install.md>

## Rules for the agent

- Run every step in the user's own Terminal session on the Mac that will run Caxri.
- Ask the questions in [step 2](#2-ask-about-optional-setup) once, together, before installing.
  Skip any setting the user does not care about; Caxri's defaults are fine.
- Never delete the user's profile (`~/Library/Application Support/Caxri`) or Project folders.
- Stop and report the exact command and its output when a step fails. Do not continue past a
  failed checksum.
- Finish with a short summary: the installed version, what was configured, and anything the user
  still has to do by hand.

## 1. Check the Mac

Caxri needs an Apple Silicon Mac on macOS 13 (Ventura) or later.

```bash
uname -m                 # must print arm64
sw_vers -productVersion  # must be 13.0 or later
```

If either check fails, stop and tell the user Caxri does not support this Mac.

Caxri runs the Agent CLIs the user already has; it does not bundle one. Check which are installed:

```bash
for cli in claude codex grok; do command -v "$cli" >/dev/null && echo "$cli: installed" || echo "$cli: missing"; done
```

If none is installed, tell the user Caxri needs at least one Agent CLI (Claude Code, Codex, or Grok
Build), installed and signed in following its vendor's instructions. Installation can still
continue.

## 2. Ask about optional setup

Offer these choices in one message. Every item is optional.

1. **Command line.** Add the `caxri` command to `PATH` so Agents and Terminals can drive Caxri?
2. **Settings.** Any of the [initial settings](#initial-settings) below, such as the interface
   language, the default Agent, font sizes, or the external editor.

Notification banners need no setup: Caxri ships its notification helper inside the app.

## 3. Install

Quit a running Caxri first; the script refuses to replace a running app. If the user has unsaved
work or running Agents, ask before quitting.

```bash
osascript -e 'quit app "Caxri"' 2>/dev/null || true
curl -fsSL https://raw.githubusercontent.com/tjx666/caxri/main/install.sh | bash
```

The script uses only tools macOS ships (`curl`, `shasum`, `hdiutil`, `ditto`, `xattr`). It:

- resolves the latest release from <https://github.com/tjx666/caxri/releases/latest> without the
  rate-limited GitHub API;
- downloads `Caxri-<version>-arm64.dmg` and its `.sha256`, and stops with
  `does not match its published SHA-256 ... Nothing was installed.` on a mismatch;
- copies the app out of the read-only disk image into a staging folder, clears the download
  quarantine attribute on that copy only (Gatekeeper stays on for everything else), and swaps it
  into `/Applications/Caxri.app`, restoring the previous app if the swap fails;
- never touches the profile (`~/Library/Application Support/Caxri`) or Project folders.

| Variable            | Effect                                                         |
| ------------------- | -------------------------------------------------------------- |
| `CAXRI_VERSION`     | Install this version (for example `0.0.147`) instead of latest |
| `CAXRI_INSTALL_DIR` | Folder that receives `Caxri.app`; defaults to `/Applications`  |

Every failure prints one `Caxri install failed: <reason>` line naming the step and what to do; report
it to the user verbatim. When `/Applications` is not writable, rerun with
`CAXRI_INSTALL_DIR="$HOME/Applications"`. Caxri is ad-hoc signed but not notarized; if macOS still
blocks it, see [Troubleshooting](troubleshooting.md#macos-says-caxri-is-damaged-or-blocks-it).

## 4. Apply the optional setup

### Command line

The app ships a launcher at `/Applications/Caxri.app/Contents/Resources/bin/caxri`. Link it into
`/usr/local/bin`, which every macOS login shell already has on `PATH`:

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf /Applications/Caxri.app/Contents/Resources/bin/caxri /usr/local/bin/caxri
```

`sudo` asks for the user's password; let the user type it. The Command Palette's **Install 'caxri'
Command in PATH** creates the same link from inside the app. See [CLI](cli.md).

### Initial settings

Settings live in `~/Library/Application Support/Caxri/config/settings.jsonc`, a JSON-with-comments
object keyed by the setting names below. The file may list only the settings the user chose; Caxri
fills in every other default on launch. Write it while Caxri is quit:

```bash
config="$HOME/Library/Application Support/Caxri/config"
mkdir -p "$config"
cat > "$config/settings.jsonc" <<'JSON'
{
  "workbench.language": "zh-CN",
  "session.defaultAgent": "codex",
  "terminal.fontSize": 14
}
JSON
```

If `settings.jsonc` already exists, this is a reinstall: edit only the chosen keys in place and keep
everything else. A value of the wrong type makes Caxri reject the file at launch, so use exactly the
types listed here.

| Setting                                           | Values (default first)                             | Effect                                                  |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `workbench.language`                              | `null` (follow macOS), `"en"`, `"zh-CN"`           | Interface language                                      |
| `session.defaultAgent`                            | `null`, `"claude"`, `"codex"`, `"grok"`, `"shell"` | Agent a new Session starts with                         |
| `session.openAgentsInChat`                        | `true`, `false`                                    | Open Agents in Chat; `false` opens them as a Terminal   |
| `terminal.fontSize`                               | `13` (integer)                                     | Terminal font size                                      |
| `terminal.fontFamily`                             | `null`, any CSS font list                          | Terminal font                                           |
| `editor.fontSize`                                 | `13` (integer)                                     | Editor font size                                        |
| `workbench.fontFamily`                            | `null`, any CSS font list                          | Interface font                                          |
| `window.zoomLevel`                                | `0` (integer)                                      | Whole-window zoom; each step is about 20%               |
| `workbench.externalEditor`                        | `"code"`, any editor command                       | Command that opens files in an external editor          |
| `agents.notifications.enabled`                    | `true`, `false`                                    | System notifications for Agent turns                    |
| `agents.notifications.completionThresholdSeconds` | `15` (integer)                                     | Notify about a finished turn only when it ran this long |
| `primarySidebar.autoCollapseProjects`             | `"30m"`, `"off"`, `"2h"`                           | Collapse Projects with no activity for this long        |
| `statusBar.usage.limitWindows`                    | `"auto"`, `"fiveHour"`, `"weekly"`, `"both"`       | Which Agent usage limits the status bar shows           |
| `agentChat.autoContinueAtUsageLimit`              | `true`, `false`                                    | Continue a Chat automatically once a usage limit resets |
| `terminal.idleSuspension.enabled`                 | `false`, `true`                                    | Suspend Agents idle in the background to save memory    |

Everything else, including the color theme, is easier to change in **Settings** after launch. The
theme picker offers Dracula (the default), Solarized Light, and other built-in palettes.

## 5. Launch

```bash
open -a Caxri
```

Tell the user to add a Project folder from the welcome screen's **Add Project** button and start a
Session; the [getting started guide](getting-started.md) explains the rest. Caxri updates itself
from then on; see [Desktop updates](desktop-updates.md). Running the install command again also
updates it in place.
