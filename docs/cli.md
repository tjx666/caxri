---
kind: living
status: current
---

# The `caxri` CLI

This is the user-facing manual: what the CLI does and why. For Agent Endpoint capability, credential,
and installation-contract detail an agent needs to work on the CLI safely, see
[CLI authority and the distributed Agent guide](../.agents/skills/project-architecture/references/cli.md).

The scriptable `caxri` CLI talks only to the authenticated, profile-scoped Server. It never
reads Caxri's SQLite database, settings, or logs directly.

## Quick start

1. Open the Caxri app, press the Command Palette shortcut, and run
   `Shell Command: Install 'caxri' Command in PATH` (details in [Installing `caxri` on `PATH`](#installing-caxri-on-path)).
2. Open a new terminal window so it picks up the command.
3. Try these:

```console
$ caxri open .          # shows this folder in the Caxri app (add it first with `caxri project add .`)

$ caxri project list
ID         TITLE   PATH
prj_8f2a1  my-app  /Users/you/code/my-app

$ caxri session list
ID         TITLE      STATE    LAST ACTIVE
ses_41c9e  Fix login  idle     5 minutes ago
ses_77b0d  Old spike  archived 3 days ago
```

The IDs and times above are examples. `caxri --help` lists these everyday commands first, and
`caxri skills get caxri-cli` prints the guide your coding agents read.

If Caxri is not running, the CLI says so and suggests opening the app or running
`caxri desktop focus --launch`.

## From source

Contributors can build the CLI from a checkout. Local help and protocol introspection work without
a running Server:

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

Human TTY output is concise text: `project`, `session`, and `terminal` `list` print a table
(`show` and `current` print `key: value` lines), with times shown relative to now. `--json`
reserves stdout for one stable JSON value and is unchanged by the readable output, while
`--quiet` emits one opaque ID per line: the resource the command read or changed, such as the
created Session, delegation, dispatch, or message. An Agent Endpoint prints as the
`<host-id>:<endpoint-id>:<generation>` reference that other `agent` commands accept. A mutation whose result has no stable ID refuses
`--quiet` before it runs rather than failing after its effect already happened. Supported Agent and
CI environments default to JSON and do not prompt.

### Profiles and `--profile`

The default profile is the app's own data folder (on macOS,
`~/Library/Application Support/Caxri`). Read-only commands use it without any flag. A mutation
(`open`, `project add`, `settings patch`, and so on) must name its profile, so a script or Agent
can never change the wrong one by accident. The rule:

- **Interactive:** a person in a terminal (stdin and stdout are both a TTY, no Agent or CI
  environment, no `CAXRI_USER_DATA_DIR`, no endpoint credential) may omit `--profile`; the
  mutation targets the default profile and asks for confirmation.
- **Non-interactive:** scripts, CI, Agents, and piped output must pass `--profile <absolute-path>`
  and `--yes`. The error prints the exact command to copy, including the resolved default profile
  path.

Select another isolated profile with `--profile <absolute-path>` at any time.

## Command surface

The shared business surface includes `project list|show|current`, `session list|show|current`,
`terminal list|show`, `project add <path>`, `host status|stop`, `settings get|validate|patch`, `logs query|follow`, `diagnostics snapshot`,
and `events watch`. Settings writes accept repeated `--set key=value` arguments;
`settings validate` and `settings patch --dry-run` use the authoritative Server schema without writing.
Pass `--request-id <id>` when a mutation must be safely retried. Streaming commands stop on
Ctrl+C, keep data on stdout, and send keepalives or cursor-gap warnings only to stderr.
`logs query|follow` also accept `--session-id`, `--terminal-id`, `--project-id`, and `--trace-id`; each
record carries its correlation `context` and, for faults, a closed `failure` classification.

The owner's own CLI (not an Agent Endpoint or a paired phone) can also find and tidy Sessions:
`session search [<terms>...] [--provider <provider>]... [--status all|caxri|archived|external]`
searches every provider's history like Desktop's Session search, `session import <key>` adds an
`external` result (its `key`, `<provider>:<conversation-id>`) as a Session, and
`session rename <id> --title <text>`, `session pin <id>`, and `session unpin <id>` match the
sidebar's actions. An Agent may also run `session import` for a conversation that ran inside its own
Project, so a user can ask it to restore one; a conversation elsewhere, or one that would need a new
top-level Project, is `FORBIDDEN` and stays the owner's to import.

`request <method> [--params <json|->]` is the generic entry for any Server method the caller is already
authorized for and that has no dedicated command, for example `caxri request session.query --params
'{"mode":"list"}' --json`. `--params -` reads the JSON from stdin. It reuses the normal transport,
confirmation (`--yes`, explicit `--profile`, `--request-id` for non-read methods), and JSON output, validates
the params against the protocol schema (`VALIDATION` for an unknown method or invalid params), and adds no
allowlist: a method the caller lacks the capability for returns `FORBIDDEN`, and an owner-only method refuses
every Agent Endpoint credential. `caxri capabilities --json` lists the method names under `requestMethods`.
Use `logs follow` and `events watch` for streams.

Desktop window commands stay behind authenticated Server and Project-root authorization:
`desktop focus`, `open <path>`, and `reveal <path>`. Path commands accept an optional exact
`--session <id>`; `open` supports files and directories and launches Desktop by default, while
`--no-launch` returns `UNAVAILABLE` when no Desktop lease exists. As with every mutation,
non-interactive calls require `--profile`, `--yes`, and should use a stable `--request-id` when
retried.

`host claude-window-tick --profile <path>` runs one check of the
[Claude 5-hour window keeper](claude-windows.md); the packaged app's LaunchAgent calls it at each
planned time. It needs no `--yes`, sends at most one request per window, and refuses Agent callers.

## Agent automation

`agent delegate import --from <file>` previews dianjiang presets; `--apply --yes` explicitly replaces
the selected profile's delegation configuration. It requires owner capability
`settings.delegation.write`, never an Agent grant. See [preset import](agent-delegation.md#import-dianjiang-presets).

`agent delegate access create|list|revoke` manages owner-authorized external callers with
`agents.delegation.access`. The resulting `delegation-client` credential is limited to one Project,
Session and caller provider; it grants only delegation and does not start a Server implicitly.
See [external callers](agent-delegation.md#external-callers-and-directory-authorization).

`bot board`, `bot session create --project <id>`, `bot session archive <session-id>`,
`bot session hand-over <session-id>... [--note-file <path>]`, `bot session take-back <session-id>`,
`bot task add|update|list`, and
`bot inbox add|list|show|ack|resolve` belong to the
[Caxri Bot](caxri-bot.md). They require the `bot` capability, which only the
Caxri Bot's Agent Endpoint and the human owner hold. `agent delegate create --new-session --title <title>` (in place of
`--session <id>`) creates Caxri Bot's Session in the same request and names it; only Caxri Bot
may pass it. Hand-over and take-back are owner-only, since Caxri Bot's Endpoint lacks
`agents.control`; `--continue-handover <id>` on `agent delegate create` is Caxri Bot's side
([Hand-over](caxri-bot.md#hand-over)). Replying to, dismissing, and merging an [Inbox](caxri-bot.md#bot-inbox) item
are owner-only Desktop and mobile actions with no CLI command.

`secret list`, `secret request <NAME> --reason <text>`, and `secret exec <NAME>... -- <command>`
let an Agent use a secret the user saved in Caxri without the value entering the conversation.
They require the baseline `secrets.use` capability and bind to the caller's own Project; the human
CLI has no secret commands. See [Agent secrets](agent-secrets.md).

Agent automation deliberately separates Peer Messages (`agent message`), durable Agent lifecycle
operations (`agent dispatch` and `agent control`), and owner-only simulated input
(`terminal send`). They do not alias or fall back to one another. See
[Agent command authority](agent-command-authority.md) for the capability and audit boundaries.

## Embedded Agent skill

Every CLI artifact embeds the version-matched canonical `caxri-cli` Agent skill. `skills list`,
`skills get`, and `skills status` work without a Server. Installation requires an explicit
`--provider claude|codex|grok|antigravity` and `--local|--global` scope; Project-local is recommended, global scope
is never implied, and Caxri refuses to overwrite unmarked, modified, unknown-schema, or newer
entries. The canonical source is [`skills/caxri-cli/SKILL.md`](../skills/caxri-cli/SKILL.md), and
the CLI build validates every executable example and declared capability against the live
registries before embedding it.
