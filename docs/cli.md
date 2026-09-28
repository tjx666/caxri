---
kind: living
status: current
---

# The `caxri` CLI

This is the user-facing manual: what the CLI does and why. For Agent Endpoint capability, credential,
and installation-contract detail an agent needs to work on the CLI safely, see
[CLI authority and the distributed Agent guide](../.agents/skills/project-architecture/references/cli.md).

The scriptable `caxri` CLI talks only to the authenticated, profile-scoped Server. It never
reads Caxri's SQLite database, settings, or logs directly. Local help and protocol introspection
work without a running Server:

```bash
bun run build:cli
node apps/cli/dist/caxri.cjs --help
node apps/cli/dist/caxri.cjs capabilities --json
```

## Artifacts and Server startup

`apps/cli/dist/caxri.cjs` is the standalone artifact and requires Node.js 24 or newer. The
macOS app contains the exact same bundle at `Caxri.app/Contents/Resources/cli/caxri.cjs` plus an
app-managed launcher at `Caxri.app/Contents/Resources/bin/caxri`; that launcher uses the packaged
Electron executable only in `ELECTRON_RUN_AS_NODE=1` mode. From that exact installed layout, a
human CLI invocation derives `Contents/Resources/server`, validates its manifest, and starts the
profile Server with the artifact's pinned runtime when none exists. Agent and CI invocations never
start a Server implicitly. The standalone CLI bundle keeps offline introspection available and
connects to an existing Server without acquiring native dependencies of its own.

## Installing `caxri` on `PATH`

Installing the app does not touch `PATH`. Run `Shell Command: Install 'caxri' Command in PATH`
from the Command Palette of the packaged app to link `/usr/local/bin/caxri` to that bundle's
launcher, the same way VS Code installs `code`. `/usr/local/bin` is in macOS's default
`/etc/paths`, so new login shells find it without editing startup files. When the directory is not
writable, Caxri explains the change first and then asks for administrator privileges through the
standard macOS prompt; dismissing either prompt changes nothing. Installing again is a no-op, and a
link to another Caxri bundle is replaced. An existing regular file at that path is never
overwritten.

`Shell Command: Uninstall 'caxri' Command from PATH` removes the link only when it points at a
`Caxri*.app/Contents/Resources/bin/caxri` launcher, so an unrelated `caxri` stays in place. Unpackaged
development launches have no self-contained launcher and report the install command as
unavailable. Because the link names the bundle path, it keeps working across in-place app updates
and dangles only after the app is deleted.

## Output modes and safety

Human TTY output is concise text. `--json` reserves stdout for one stable JSON value, while
`--quiet` emits one opaque ID per line: the resource the command read or changed, such as the
created Session, delegation, dispatch, or message. An Agent Endpoint prints as the
`<host-id>:<endpoint-id>:<generation>` reference that other `agent` commands accept. A mutation whose result has no stable ID refuses
`--quiet` before it runs rather than failing after its effect already happened. Supported Agent and
CI environments default to JSON and do not prompt. Select another isolated profile with `--profile <absolute-path>`; every mutation
requires that explicit Server selector and non-interactive confirmation with `--yes`.

## Command surface

The shared business surface includes `project list|show|current`, `session list|show|current`,
`terminal list|show`, `settings get|validate|patch`, `logs query|follow`, `diagnostics snapshot`,
and `events watch`. Settings writes accept repeated `--set key=value` arguments;
`settings validate` and `settings patch --dry-run` use the authoritative Server schema without writing.
Pass `--request-id <id>` when a mutation must be safely retried. Streaming commands stop on
Ctrl+C, keep data on stdout, and send keepalives or cursor-gap warnings only to stderr.

Desktop window commands stay behind authenticated Server and Project-root authorization:
`desktop focus`, `open <path>`, and `reveal <path>`. Path commands accept an optional exact
`--session <id>`; `open` supports files and directories and launches Desktop by default, while
`--no-launch` returns `UNAVAILABLE` when no Desktop lease exists. As with every human mutation,
non-interactive calls require `--profile`, `--yes`, and should use a stable `--request-id` when
retried.

## Agent automation

`agent delegate import --from <file>` previews dianjiang presets; `--apply --yes` explicitly replaces
the selected profile's delegation configuration. It requires owner capability
`settings.delegation.write`, never an Agent grant. See [preset import](agent-delegation.md#import-dianjiang-presets).

`agent delegate access create|list|revoke` manages owner-authorized external callers with
`agents.delegation.access`. The resulting `delegation-client` credential is limited to one Project,
Session and caller provider; it grants only delegation and does not start a Server implicitly.
See [external callers](agent-delegation.md#external-callers-and-directory-authorization).

`commander board` and `commander session create --project <id>` belong to the
[Agent Commander](agent-commander.md). They require the `commander` capability, which only the
Commander's own Agent Endpoint and the human owner hold. `agent delegate create --new-session` (in place of
`--session <id>`) creates the Commander Session in the same request; only the Commander may pass it.

Agent automation deliberately separates Peer Messages (`agent message`), durable Agent lifecycle
operations (`agent dispatch` and `agent control`), and owner-only simulated input
(`terminal send`). They do not alias or fall back to one another. See
[Agent command authority](agent-command-authority.md) for the capability and audit boundaries.

## Embedded Agent skill

Every CLI artifact embeds the version-matched canonical `caxri-cli` Agent skill. `skills list`,
`skills get`, and `skills status` work without a Server. Installation requires an explicit
`--provider claude|codex|grok` and `--local|--global` scope; Project-local is recommended, global scope
is never implied, and Caxri refuses to overwrite unmarked, modified, unknown-schema, or newer
entries. The canonical source is [`skills/caxri-cli/SKILL.md`](../skills/caxri-cli/SKILL.md), and
the CLI build validates every executable example and declared capability against the live
registries before embedding it.
