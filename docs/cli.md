# The `caxri` CLI

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
Commander's own Agent Endpoint and the human owner hold.

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
