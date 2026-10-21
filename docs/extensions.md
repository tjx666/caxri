---
kind: living
status: current
---

# Extension Host and view contributions

Caxri loads native ESM extensions in one Server Core-owned Extension Host process. Extensions contribute
descriptors before activation and provide data through the public `caxri` workspace package; they
never contribute React components or import Desktop internals.

## Process and ownership boundary

The Server Core discovers manifests, builds the only ViewContainer/View/Command catalog, records
actual grants, starts and supervises the artifact's `bundles/extension-host.js`, and validates every child
message. The Extension Host loads extension code and owns extension objects, providers, commands,
events, opaque tree handles, and cancellation tokens. Server Core domain services own SQLite,
Projects, Sessions, PTYs, files, Git, settings, and project status.

Application source must not import bundled extension implementation from `extensions/`. ESLint
enforces this direction; use the public Extension API and Host protocol instead. Build tooling may
still compose extension artifacts independently of application runtime imports.

An Extension Host crash advances every extension generation and temporarily marks contributed
containers as crashed. The Server Core and PTYs remain alive. The supervisor restarts the child and
reconfigures it from Server Core-owned descriptors. Old API bindings, providers, commands, refresh timers,
handles, pending API calls, and late tree results cannot cross the generation boundary.

This is a process-ownership and capability boundary, not a complete untrusted-code sandbox. Bundled
product extensions are nevertheless built as browser-like ESM: their emitted bundles cannot retain
Node, Electron, shell, Desktop-internal, or native Git imports. Native work is available only through
the reviewed public API and Server grants; the `desktop` principal bypass is never granted.

## Public API package

`packages/extension-api` publishes the physical ESM-only package named `caxri`. Its `exports` map provides
`types` and `import` only; CommonJS `require('caxri')` is unsupported. The default export is the
per-extension API object, while named runtime exports include `Disposable`, `EventEmitter`,
`CancellationTokenSource`, `ProjectStatusSummaryErrorMessage`, `ThemeIcon`, `TreeItem`, and
`TreeItemCollapsibleState`.

The ordinary package build contains an explicit outside-host stub. Bundled extension builds
externalize only `caxri`, and the Extension Host's native ESM resolve hook injects a synthetic
generation-scoped module instead. Contract tests reject a bundled copy of the stub and any deep
Desktop, protocol internals, Renderer, or Electron import.

The loader determines ownership from the canonical extension root and the importing module's
`parentURL`. An unowned `caxri` import fails closed. Each `(extensionId, generation)` receives a
distinct opaque API token, entry URL, synthetic module URL, API object, event namespace, and handle
namespace. The synthetic module provides both the default API and stable named runtime exports.

## Manifest

An extension package must declare `type: "module"`, a `.js` or `.mjs` entry, a compatible
`engines.caxri` range, and namespace-qualified contribution IDs:

```json
{
  "name": "publisher.extension",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/extension.js",
  "engines": { "caxri": "^0.0.18" },
  "caxri": { "capabilities": ["projects.read"] },
  "contributes": {
    "viewsContainers": {
      "secondarySidebar": [
        {
          "id": "publisher.extension",
          "title": "Extension",
          "order": 200,
          "icon": { "kind": "resource", "path": "media/extension.svg" }
        }
      ]
    },
    "views": {
      "publisher.extension": [
        {
          "id": "publisher.extension.overview",
          "name": "Overview",
          "type": "tree"
        }
      ]
    },
    "commands": [{ "command": "publisher.extension.refresh", "title": "Refresh Extension" }]
  }
}
```

Only `secondarySidebar` and `panel` are contribution locations. Container icons explicitly choose
either an allowlisted semantic icon (`{ "kind": "builtin", "id": "status" }`) or an extension
resource (`{ "kind": "resource", "path": "media/extension.svg" }`). Resource icons keep their
authored colors. Desktop's tab strip and the mobile Session tabs map a builtin id to its glyph through
one shared table (`viewContainerIconGlyph` in `@caxri/protocol`); the mobile read surface does not
project resource icons, so a phone shows such a container with the generic package glyph. The optional bounded integer `order` makes container placement independent of
extension discovery order; equal or omitted values retain stable discovery order. `onView:<id>` and
`onCommand:<id>` activation are derived from contributions, so
manifests must not declare `activationEvents`; conditional `when` clauses are likewise unsupported
until Caxri implements and validates their semantics. Caxri validates manifest and engine
compatibility with standard SemVer rules, canonical entry and icon containment, sizes, namespaces,
and duplicate IDs before running extension code. One malformed package is surfaced as its own
catalog error without hiding healthy siblings. The first discovery root is authoritative, so an
installed extension cannot replace a bundled identity.

Workbench Core controlled views may declare bounded semantic toolbar roles; Files uses the generic
Resource Explorer roles for create-file, create-folder, search, collapse, and refresh. Extension
Source Control modes and actions instead arrive in the provider's validated declarative model, with
opaque revision-bound action IDs and declared command bindings. The Renderer renders those generic
descriptors without recognizing the provider ID, product modes, or command vocabulary, and it never
accepts extension-supplied React. `allowInEditable` is an explicit per-command manifest policy used
by both DOM shortcuts and native-menu accelerators.
Commands that require provider-supplied context arguments set `palette: false`; they remain valid
declarative action bindings without exposing an argument-less command that cannot succeed.

Rejected packages receive a stable catalog-safe synthetic identity and an isolated error container.
Retry re-runs discovery, so repairing the manifest or entry on disk replaces that error container
with the extension's declared identity without restarting the Desktop.

Manifest capabilities are declarations, not grants. The Server Core records actual capability and Project
scope per extension. Bundled extensions receive their reviewed grants; installed extensions
currently receive none. Every API call validates the opaque identity, current generation,
capability, and Server Core-authoritative active Session/Project scope before returning projected data.

The declared capabilities are `git.read`, `git.write`, `projects.read`, and `settings.read`, and each
one is consumed by a real check. There is deliberately no Session capability: the active Session
identity is part of the base API context an extension receives through its lifecycle `scopeId`, not a
separate readable surface. A capability nothing checks constrains nothing, so it would read as
authority the extension does not actually hold.
Configuration reads additionally require `settings.read` and are limited to keys listed by the
extension view's `configurationDependencies`; declaring the broad capability alone cannot read an
unlisted setting.

## Unified catalog and selection

Builtin Logs and Info, Workbench Core contributions, and extension contributions share one Server Core
catalog. Files is a typed `core` contribution outside discovery and Extension Host lifecycle; Git
and Status are extension-sourced lifecycle entries. Files and Git cannot be registered as
`builtin-react`. Descriptors use `builtin-react` only for the remaining reviewed native components,
`tree` for TreeDataProvider data, `resource-explorer` for the Core filesystem view, and
`source-control` for extension-owned source control. The Renderer dispatches only these declared
kinds; extension code cannot inject a component.

The Command Palette and app-level keybindings resolve extension commands through this same Server Core
catalog. A shortcut reloads a missing, stale, or invalidated catalog before dispatch, executes the
extension command once, and reports unknown or failed commands through the shared toast path. The
native application menu does not synthesize dynamic extension accelerators.

A command callback may resolve with a `CommandResult` (`{ message }`) to tell the user what it did.
The Extension Host keeps only a string `message`, trimmed and capped at 200 characters, and ignores
any other resolved value; Server Core validates it again at the process boundary, and
`viewContainers.executeCommand` returns `{ executed: true, message? }`. Every Renderer entry point
(palette, keybinding, view toolbar, tree row, inline action) shows a returned message as a success
toast. A failure is a thrown error, never a message. The Status extension's merge commands return
the merge method Server Core chose (`Squash-merged #123`, `Merged #123`, `Rebase-merged #123`).

Like a view operation, `viewContainers.executeCommand` carries the view context of the Session it was
issued in. A command can wait behind another repository mutation while the user switches Session, so
Core rejects it with `CANCELLED` instead of running it against the newly selected Session (a "merge
the current branch's pull request" command would otherwise merge the wrong pull request). `host.stop`
drains running Extension commands and `source.action` mutations before it accepts, and rejects new
ones with `UNAVAILABLE` while it drains, even when it then refuses to stop because PTYs are live.

Session SQLite persists the free, bounded
`desiredSecondarySidebarViewContainerId`. Device-local layout persists
`desiredPanelViewContainerId`. The Renderer derives a currently available resolved ID from the
catalog. Missing, disabled, crashed, or downgraded extensions cause a temporary first-available fallback
without rewriting desired state. Restoring the extension rebinds the same desired ID. Only an
explicit user selection updates desired state.

## Controlled Resource Explorer and Source Control RPC

The Core Resource Explorer calls the public typed `files.*` table directly with the selected Session
as a scope selector. Caller-owned request identity plus `requests.cancel` propagates an AbortSignal to
Server Core without exposing arbitrary IPC. Server Core resolves and revalidates the Session's authorized
Workbench Project root immediately before filesystem execution; Finder reveal and Trash remain
bounded Desktop operations. Directory enumeration streams at most 4,096 candidates before applying
the smaller sorted 1,024-entry and serialized-byte page limits, so a large directory cannot inflate
Server Core memory before protocol bounds apply. Files never enters extension activation, generation,
capability, or provider lifecycle.

`registerSourceControlProvider` is the public declarative extension view contract. Snapshot,
history, details, and action calls carry an opaque request ID, cancellation token, provider revision,
and Server-owned Session/Workbench Project context. The Extension Host scopes `workspace.git` calls to
that context, Server Core rechecks the grant, and the Git domain remains the final authorization boundary. Explicit
cancellation is a typed `CANCELLED` non-fault; superseded provider or Extension Host generations fail with
`GENERATION_EXPIRED`. Neither code is a reserved word of the Extension API: a provider may throw any
`code`, including these two. In the Extension Host diagnostic log, a failed provider call is classified from host-owned request
state, never from the error object: a `CANCELLED` is a non-fault only when the host itself cancelled that request, and a
`GENERATION_EXPIRED` only when the host's provider registration or extension instance actually turned over, or when
Server Core itself cancelled or expired a `caxri.*` call the extension awaited during that request (a Session switch
mid-read). Extension-triggered state does not count: a tree provider's own refresh, a registration the extension
disposed itself, or a `caxri.*` call made outside any Server-supplied view context (from `activate()` or a timer)
that the controlled-view scope fence rejected. Any other error thrown by
extension code (from a provider, a contributed command, or `activate()`) is logged as a real fault regardless of
which `code` it carries, and a host-minted rejection an extension re-throws gains nothing from its origin.

`caxri.supersededError(message)` is the one exception, and it exists because one staleness is genuinely
invisible to the host: a provider's own model revision. A provider that keeps a revision and rejects
requests carrying an older one (as the bundled Git extension does for superseded snapshots and expired
actions) throws this instead of constructing its own `GENERATION_EXPIRED`, and the call is then logged
at `debug` with `remediation: none`. What the classifier recognizes is the object the host minted, not
the code on it: a copy carrying the same `code` and message is still a fault, so the guarantee above is
unchanged for every extension that does not call this factory. Calling it is a trust contract the
extension author takes on: Caxri records the outcome as routine because the extension said it was, so
wrapping a genuine failure in it hides that failure from diagnostics. There is deliberately no general
`nonFailureError(code)`; this factory can express only "superseded". Outside the Extension Host the
same call returns an equivalent unregistered error, so a provider stays unit-testable and an
unregistered error classifies exactly as it did before this contract existed.

Server Core's wire handling of these two
codes (retrying a superseded tree read, converting a superseded read into `CANCELLED` for the Renderer) is unchanged
and keeps keying on the code string. A superseded view action whose Extension Host generation did not turn over
becomes `CONFLICT`: the provider refused it before running anything. The Source Control Renderer treats that
`CONFLICT`, and a click that lands while its snapshot is still refreshing, the same way: it waits for the refresh,
finds the action with the same command binding in the fresh model, and runs that, for at most three attempts before
showing a warning. Extensions cannot submit a Session ID, repository path, shell command, or
native API request. The Git domain owns Git execution, repository discovery, approved-repository identity,
and the bounded Desktop bridge used by discard confirmation. A discard request carries only an
opaque repository ID and either an all-changes intent or a relative file path; the Git domain derives the
repository name, changed-file count, and tracked/untracked semantics from its authorized status
snapshot before Desktop renders the confirmation.

Server `files.changed` and `files.operationChanged` events directly invalidate Core Resource
Explorer reads and operation recovery without an Extension Host echo or path exposure to extensions.
Completed create/rename/move records are applied to all same-Project Session editor state before
acknowledgement. Operation IDs coalesce repeated actions, staged cancellation never pretends a
filesystem mutation rolled back, and unacknowledged records are recovered after Renderer or Server Core
restart. Different-Project operation records are neither returned nor controllable.

Git provider results carry opaque repository IDs selected by the Git domain. The Git extension turns raw
summary, pull-request, commit, history, and remote-host results into the complete Source Control view
model: modes, repository/group/resource descriptors, copy, counts, disclosure, icons, actions, and
command bindings. Refresh, Sync, Discard All, single-file discard/delete, diff opening, and history
execute through revision-bound action capabilities. Renderer understands only generic
snapshot/history/details/action operations and generic effects such as open-editor, toast, and
refresh. A provider may also publish one `externalLink`, which the Renderer opens in the default
browser on an Alt-activated row instead of routing through the action registry; there is no
Extension Host work behind it. A provider whose branch row badge is actionable names the action it
runs with `descriptionBadgeActionId`, the `id` of one of that provider's `actions`: the Git extension
points its unsynced-commit badge (`↑2 ↓1`) at its Sync action, and the Renderer resolves the badge by
that id rather than by matching a Git command id. Resource identity remains stable and bounded independently from full Git paths.
Git also bounds path-derived labels, tooltips, accessibility text, and tree paths to the controlled
surface contract. An encoded diff URI that exceeds the generic open-editor limit is omitted instead
of invalidating the whole snapshot; destructive action arguments retain the full Server-authorized
path.
The global background-detail limiter starts every waiter in its originating Workbench scope before it
waits for a slot, preserving Extension Host AsyncLocalStorage authorization while maintaining FIFO
fairness. Git invalidation and Session/Project changes enter the extension event namespace, where the
provider advances its revision and retires stale state rather than retaining an old root or repository
grant. Once an authorized Sync or Discard crosses its mutation boundary, a concurrent invalidation
cannot turn its authoritative completion into a retryable stale-generation error. Cancellation still
propagates to Server Core, but non-expiring mutations keep their API request pending until Server Core distinguishes
pre-boundary `CANCELLED` from an authoritative post-boundary completion.

View operation policies are exhaustive over the public protocol's operation union. Adding an
operation must also define its result schema, provider dispatch, read-cancellation behavior, and
request lifetime. Shared policy metadata does not grant capabilities: Core still authorizes the
target view and active context, and the Host still validates the provider registration and generation.
The four snapshot/history reads remain cancellable; `source.action` retains its authoritative
completion and non-expiring request lifetime.

Core reads the active context through the internal `app.activeContext` method, which returns only
the selected Session's identities and the visible Project IDs. Every view operation and routed
domain event needs that slice, so reading the whole `app.bootstrap` there made the bridge the source
of almost every bootstrap read. Record-level `state.changed` events never reach this read: only a
full change that can move the selection (`session.select`, `session.create`, `session.delete`,
`session.workbenchRoot`) notifies the Host of a new active context.

Private protocol rejection logs use `extension_host.invalid_message` with one closed `reason`:
`parent-envelope`, `child-envelope`, or `reply-result`. These distinguish the receiving boundary
and validation stage without recording the rejected message, provider output, or error text.

## View badges

A contributed view opts in with `"badge": true` in its manifest and registers a
`ViewBadgeProvider` through `caxri.views.registerViewBadgeProvider(viewId, provider)`.
Content and badge registrations are independent, so a tree or Source Control provider can share
the same view ID with its badge provider.

`provideBadge({ scopeId }, token)` returns a `kind` and a bounded plain-text `description`. A
`count` badge is a plain tally and requires a nonnegative integer `count`. An `error` or `warning`
badge is a severity and carries no `count` field at all; say how many in `description`. Return
`undefined` or `null` when unavailable; the Host normalizes that result to wire-safe `null`. An
explicit zero is hidden.

An extension reports what the activity means and never how it looks: no color, icon, or priority
crosses the API, so one container never shows two views' badges in two unrelated colors. The
Workbench draws its own fixed glyph for `error` and `warning`, keeping severity legible without
color, and paints each kind from its own theme role (`badge`, `errorBadge`, `warningBadge`).

Within a container, severity takes the badge outright: `error` beats `warning`, and either beats
every tally, which then does not appear on the chip at all. Only `count` badges are totalled, and
their total is capped at `99+`; summing across kinds would let 20 ordinary items and 1 failure
render as a red `21`. Severity and tally never share a chip, because a digit would displace the
glyph and leave the fill as the only difference between "5 changes" and "5 failures"; nothing to a
colorblind user or in a greyscale capture. This matches VS Code, whose composite-bar badges are a
strict `progress` > `icon` > `number` ladder and whose `ErrorBadge`/`WarningBadge` have no number.
The displaced tally is not lost: every contributing view's description is joined and published as
the container tab's tooltip and accessible description, whatever the chip shows.

The Renderer issues `badge.snapshot` before the view opens, activating declared providers and
sharing concurrent activation by extension generation. Reads carry the same cancellation and
Session/Workbench Root fences as content operations. Query keys also include the provider
generation, and returning to an inactive scope revalidates its cached count. Crashed, disabled,
and failed extensions contribute no badge.

Emit `onDidChangeBadge` inside a scoped Workspace notification or provider callback. The Host
forwards a scoped `badge` invalidation, not a cached count; unscoped events are ignored. Badge
invalidations bypass the hidden-view command replay queue. Disposing an extension retires both
its content and badge registrations.

The bundled Git provider sums `changedFileCount` across the selected Workbench Root's
repositories, regardless of diff mode, exclusions, or payload truncation. The Status extension
owns failed-check and current-deployment aggregation. Both reuse Server domain caches rather
than starting a separate native polling loop.

Vercel deployment rows (Production, Preview, and branch deployment children) open the selected
deployment's Vercel details page, including canceled, pending, and failed attempts. Server Core
reads bounded deployment lists through `vc api` to retain the stable deployment ID; the site
hostname is not an inspector identifier. The hover card keeps the site URL as a separate `alias`
action. Production represents the merged PR's exact merge commit when one is known, otherwise the
checked-out branch's latest production attempt. Preview still represents the local HEAD's latest
preview attempt. A branch with neither a matching merged PR build nor its own production build
shows no Production row rather than the default branch's live build under a "shipped" glyph. Opening details does not substitute an older successful
deployment.
Canceled deployments retain neutral aggregation semantics but display a muted circle-slash icon
and explicit `canceled` text in the environment summary and hover-card badge. Branch deployment
children use a trailing environment icon (circle-arrow-up for production, eye-with-magnifier for preview)
instead of repeating environment and status text. Hover cards and accessible labels preserve both
facts. `TreeItem.trailingIcon` carries optional metadata as a validated theme icon across the Host
boundary; it does not create a separate action or keyboard stop.

## Tree RPC

Extension element type `T` never leaves the Extension Host. The process boundary carries
opaque handles and validated `TreeItemDTO` values. An explicit `TreeItem.id` is unique within its
View and produces stable identity when a provider rebuilds element objects or the Extension Host
restarts. Duplicate IDs fail the affected provider branch. Items without an ID retain only a
generation-local object handle and have no cross-refresh persistence guarantee. Replacing a parent
retires its removed descendants before the bounded handle capacity is evaluated.

`TreeItem.variant = 'header'` is the optional, domain-neutral presentation contract for an item that
introduces a visually separated group of children. The shared Renderer gives it header emphasis and
a section divider; providers must opt in explicitly rather than relying on root depth or label
conventions. `TreeItem.variant = 'message'` presents a readable icon, label, description, and optional
command action for a complete empty, prerequisite, or failure state instead of truncating that guidance
into an ordinary row. A message must be a leaf; the validated process boundary rejects a collapsible
message. It keeps the tree's roving focus and Enter command path, suppresses the redundant row Tooltip,
and disables its visible action while the View refresh is pending. Ordinary tree rows remain the default.

`TreeItem.tooltip` accepts either the existing bounded plain string or a bounded `rich` payload with
a title, an optional prose description or Markdown body, an optional semantic badge, and up to eight
labeled rows. The rows may be omitted entirely, so a provider can give a row with no structured facts
the same hover card instead of dropping back to the plain string. Rich descriptions and row values are
always rendered as text; an optional URL must be credential-free HTTP(S), is validated by the Extension
Host, and still crosses Main's trusted-origin confirmation before the operating system can open it.
The `markdown` body (at most 8 KiB, exclusive with `description`) is for authored prose such as a pull
request review comment. `@caxri/markdown`'s `parseMarkdownBlocks` reduces it to a closed, HTML-free
block tree (paragraphs, headings, lists, quotes, code, emphasis, and HTTP(S) links) that the
Renderer draws as React text nodes: raw HTML and tables are dropped, images collapse to their alt text,
and links open through the same external-link policy. HTML, scripts, commands, and `command:` URLs are
not part of this contract.

`TreeItem.actions` adds up to three inline actions to an ordinary row. Each is a command, a
validated theme icon, an optional `confirmation` (title, message, confirm label), an optional
`tooltip`, and optional `feedback`. The Renderer
shows them as icon buttons at the end of the row while it is hovered or holds keyboard focus,
except an action with a `label` or a `tone`, which stays visible at rest. A `label` makes it the
row's primary call to action, rendered as a compact text button; a `tone` (`neutral`, `success`,
`warning`, `danger`) colors it, as a text button or as an icon. Project Status uses them for the
pull request merge button: green `Merge` text when nothing blocks the merge, otherwise only the merge
glyph (`danger` for failed checks, `warning` for branch protection or a base that moved ahead,
neutral while checks run or GitHub has not computed mergeability), which leaves the row's width to
the title. The Renderer keeps a running action visible and busy until its command settles, and
dispatches through the same `viewContainers.executeCommand` path as the row's own command. A
`confirmation` is shown as literal text in the Workbench confirmation modal; cancelling dispatches
nothing and returns focus to the action. Inline actions do not replace `TreeItem.command`, which
stays the row's activation.

`tooltip` states why the action is in its current state (`Checks still running`) so `command.title`
can stay the plain action name. It is shown on hover and on keyboard focus and becomes the button's
accessible description; without it the tooltip is the command title and opens on hover only.
`feedback` declares toast copy, because the action is the only place that knows what the row means:
`success` is the fallback success toast when the command resolves without its own `message`,
`failure` prefixes the command's sanitized reason (`Couldn't merge #123: <reason>`), and `githubUrl`
(credential-free HTTP(S), validated like tooltip URLs) adds an Open on GitHub button to both toasts.

A row command or an inline action whose command is the Workbench's `caxri.openExternal`, with the URL
as its first argument, opens the page through the external-link policy in the Renderer, without a
round trip to the extension. Project Status uses it for a draft pull request: the merge action
explains why a draft cannot merge and confirms with Open on GitHub.

An action whose command is the Workbench's `caxri.sendToAgent`, with a prompt string as its first
argument, sends that prompt to the selected Session's Agent from the Renderer, since an extension
has no authority over Agents (`features/terminal/agent-prompt-commands.ts`). The target is a Chat
Terminal or a Terminal whose Agent is running, a visible one first and then the most recently
opened. A Chat receives it as a message, queued behind a running turn; a Terminal Agent receives one
bracketed paste followed by Enter once its pane has attached. Control characters other than
newlines and tabs are stripped first. The Agent is revealed and the success toast names it; the
action's `feedback.failure` prefixes the reason when there is no Agent or the write fails. Project
Status uses it for the green `Fix` button on the `Review` group (shown while threads are unresolved), which sends every
unresolved thread (repository, pull request, location, author, link, and text, with long bodies
clipped) to the Agent as suggestions to weigh, not instructions: the Agent changes code only for the comments it agrees
with and says why it leaves the rest. Nothing is resolved on GitHub, so it does not confirm first. A failed
Production or Preview deployment row gets a red `Fix` button that sends the deployment, its commit,
and its build-log link, asking the Agent to fix a code cause or explain an outside one without
redeploying by hand. A pull request
that conflicts with its base gets a red `Resolve` button in place of the merge button GitHub would
refuse: it asks the Agent to rebase onto the latest base, resolve the conflicts, run the covering
checks, and push with `--force-with-lease`, leaving the merge itself to the user. A pull request whose
checks failed gets a red `Fix` button before its red merge glyph: it sends each failed check with
its run link and the head commit, asking the Agent to read the failed logs, fix a code cause and
push, or explain a flaky or outside one, without merging. The merge glyph stays for a deliberate
`Merge Anyway`. Like every Send-to-Agent button, it goes to the selected Session's Agent; a Chat
queues it behind a running turn.

Keyboard users reach them the way an ARIA treegrid reaches a row's cells: Right on a focused leaf or
expanded row moves into the first action (a collapsed row still expands first, and Down still enters
an expanded row's children), Left and Right move between actions, and Left from the first action or
Escape returns to the row. Enter or Space runs the focused action. The row's accessible description
lists its actions, and the actions stay out of the Tab order until focus enters them, so the tree
keeps one Tab stop. Rows without actions keep the plain tree keys.

Right-clicking a row (or Control-clicking it), or pressing `Shift+F10` or the Menu key while it holds
focus, opens a native context menu built only from what the row already exposes: the row's own
`command` first, then its inline actions in button order, each labeled with its command title.
Choosing an entry runs exactly what the matching click runs, an action's confirmation and feedback
included (`extension-tree-row-menu.ts`). A row with neither, and a message row, opens no menu.
Menu-only actions, VS Code's `contextValue` with `view/item/context`, are not part of the Extension
API yet.

The Status extension uses this for its pull request row: a merge action appears on an open pull
request whose head is known and that GitHub does not report as conflicting (a draft gets the Open
on GitHub explanation above, and a conflicting one the Agent's `Resolve` button instead). The palette command `Merge Pull Request for
Current Branch` merges the primary repository's pull request only when nothing would make the row
confirm, and otherwise refuses with the reason. It calls
`workspace.git.mergePullRequest`, which needs `git.write`. Server Core reads the repository's allowed
merge methods, picks squash, then a merge commit, then rebase, and runs `gh pr merge` with
`--match-head-commit` set to the head the row showed, so a later push makes GitHub refuse the merge
instead of merging unseen commits. It never passes `--delete-branch`; the repository's own
auto-delete setting owns the remote branch, and a linked worktree may still have the local one
checked out. The action merges a pull request whose filtered checks passed and whose merge state is
clean without asking; it confirms first when checks are failing or still running, or when GitHub
reports the pull request `blocked`, `behind`, or not yet computed. GitHub's `unstable` alone does not
ask, because the only red or running checks left may be ones the user chose to ignore.

With the `projectStatus.notifyAgentOnMerge` setting on (default on), Server Core sends a best-effort
message to the Session's primary Agent naming the merged pull request's URL: a fenced submit pinned
to the current launch for a Terminal Agent, or an ordinary turn for a Chat Agent. It fires once per
pull request however the merge happened: the Project Status button, GitHub, or another person. The
Session pull request sweep notices a pull request that it saw open turn merged, so a pull request
that was already merged when Server Core started is never announced. The button path records its
send first, so a sweep that sees the same merge does not send a second message. A merge whose
`mergedAt` falls inside one of that Session's Agent turns (plus a few seconds of clock skew) is
skipped as `self-merged`, because the Agent that merged it already knows. A missing or stopped Agent
never fails the merge; each attempt logs `git.merge_agent_notice` with a closed `outcome`
(including `self-merged` and `duplicate`). Server Core remembers turn windows only for its own
lifetime, so a pull request merged while Caxri was closed is not announced.

With the `projectStatus.autoArchiveOnPullRequestSettled` setting on (default on), the same sweep
archives a Session whose pull request was seen open and then became merged or closed, using the
sidebar's own Archive operation (metadata only; nothing on disk is deleted, and Archived Sessions
can restore it). It waits until the Agent is idle: a running or waiting Agent defers the archive
until its turn ends, and the merge notice's turn gets a 20 second grace window so the Agent can finish
reacting to it first. A Chat turn that ended while a background shell or subagent it started still
runs (an Agent watching a deploy in the background) also defers; that work can finish without an
activity change, so the archive re-checks every 30 seconds. Each decision logs
`session_pull_requests.auto_archive` with a closed `outcome` (`archived`, `deferred`, `disabled`,
`failed`, `reopened`, `session-gone`); `deferred` carries a `reason` (`agent-busy`, `notice-turn`,
`background-work`) and is logged again when the reason changes.

The shared Renderer owns virtualization, the side bar scroll cue
([secondary-sidebar-trees.md](secondary-sidebar-trees.md)), ThemeIcon rendering, roving focus,
arrow/Home/End navigation, expansion, loading/empty/provider-error rows, local Retry, tooltip presentation, and
ARIA tree semantics. Provider `Expanded` is applied only the first time a logical item appears;
later user expansion wins. Bounded stable-ID expansion and focus state is stored in the existing
Session/Workbench-Root JSON per View, so it survives root/target refresh and restart without leaking
to another Session. Pointer and keyboard actions share one dispatch gate: Chromium's
click-click-double-click sequence cannot execute a leaf command more than once.

Tree requests have bounded item count, payload size, handle count, depth, concurrency, and timeout.
Cancellation reaches the provider token and crosses every transport boundary as the typed
`CANCELLED` non-fault outcome. A cancelled or stale request cannot commit handles or late results.
Provider refreshes are coalesced and generation-checked at the Extension Host,
supervisor, service, and Renderer event boundary.

`getParent`, `resolveTreeItem`, `TreeView.reveal`, webviews, custom editors, Marketplace installation,
extension dependencies, signing, automatic updates, and an untrusted extension sandbox are not v1
contracts.

## Bundled extensions and packaging

`extensions/git` and `extensions/status` are product extensions. Their emitted
bundles may retain only the external public `caxri` import; a fail-closed build contract rejects
Node/Electron builtins, Desktop internals, workspace packages, third-party imports, and dynamic
`import`/`require` escape hatches. `extensions/fixture` is test-only and supplies deterministic lazy,
cancellation, failure, timeout, capacity, deep-tree, virtualization, refresh, and crash paths. Each
extension is an independent pnpm workspace package with a package-local TypeScript program and a
development-only `caxri: workspace:*` dependency.

`bun run build:extensions` orchestrates package-local ESM builds with `caxri` externalized. The
Server artifact builder copies exactly Git and Status manifests, bundles, icons, and media assets
under `server/extensions`; it carries neither Fixture nor extension source maps. `package:e2e`
rebuilds a separate, fully manifested Server artifact that adds Fixture explicitly, packages it,
and then restores the production artifact. Server Core `testOnly` filtering remains defense in depth,
not the release-artifact boundary. The Server starts the Extension Host from
`server/bundles/extension-host.js`; installed extensions, when present, are discovered from
`<userData>/extensions` after bundled identities.

Focused validation lives in the API, protocol, discovery, catalog, supervisor, API factory,
persistence, bundle-contract, and Renderer resolution tests. `e2e/extensions.e2e.ts` exercises lazy
and provider-owned expansion, stable state across targeted and root refresh/restart, Session
isolation, tooltip/empty/error states, exactly-once pointer and keyboard commands, virtualization,
crash recovery, Terminal survival, and desired-ID removal/restoration on the real Electron surface.
