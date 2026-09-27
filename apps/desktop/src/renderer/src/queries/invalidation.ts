import { useEffect } from 'react';

import type { CaxriMethod, ServerEvent } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';

import type { ControlledViewQueryOperation } from '../features/view-containers/view-operation-client';
import { caxri } from '../lib/caxri';
import { parentDirectoryPath } from '../lib/file-path';
import { getWorkbenchProjectSessionIds } from '../stores/selectors';
import {
    CONTROLLED_VIEW_QUERY_METHOD,
    EXTENSION_TREE_CHILDREN_QUERY_METHOD,
    isQueryMethod,
} from './client';

/**
 * Debounce window used to coalesce a burst of `files.changed` events into one invalidation pass.
 */
const FILE_CHANGE_INVALIDATION_DEBOUNCE_MS = 150;

/**
 * `files.operation.get` and `files.operation.list` are deliberately absent: the Resource Explorer issues those as
 * direct `caxri.request` calls (`resource-explorer-client.ts`), so they are never cached under a controlled-view key
 * and listing them here matched nothing. `files.search` left for the same reason when Project search moved out of the
 * view container into its own overlay, which caches under the flat `projectSearchQueryKey` instead.
 */
const RESOURCE_EXPLORER_READ_OPERATIONS = new Set<ControlledViewQueryOperation>(['files.list']);
const SOURCE_CONTROL_CONTENT_OPERATIONS = new Set<ControlledViewQueryOperation>([
    'source.snapshot',
]);
const BADGE_OPERATIONS = new Set<ControlledViewQueryOperation>(['badge.snapshot']);

/**
 * Query-key prefixes for whole-method invalidation. Annotated rather than inferred so a renamed method is a compile
 * error here, instead of a predicate that quietly stops matching anything.
 */
const CATALOG_QUERY_KEY: readonly [CaxriMethod] = ['viewContainers.catalog'];
const PULL_REQUESTS_QUERY_KEY: readonly [CaxriMethod] = ['session.pullRequests'];
const AGENT_ACTIONS_QUERY_KEY: readonly [CaxriMethod] = ['agentActions.list'];
/**
 * The Commander's rows are excluded from Workbench records, so no record-scoped change names them; any state change may
 * be the Commander's, and the read is one cheap row lookup.
 */
const COMMANDER_STATUS_QUERY_KEY: readonly [CaxriMethod] = ['commander.status'];
/**
 * Every repository's pending review comment count, across every Session — no arguments, so one invalidation covers
 * every mounted reader (the quit reminder, "Show Pending Review Comments") the same way `PULL_REQUESTS_QUERY_KEY`
 * does.
 */
const GIT_REVIEW_PENDING_QUERY_KEY: readonly [CaxriMethod] = ['gitReview.pending'];

/**
 * Reasons whose Session membership change must refresh the shared pull-request query at once. Typed from the event
 * contract so a renamed reason fails typecheck rather than silently never matching.
 */
type FullStateChangeReason = Extract<
    Extract<ServerEvent, { event: 'state.changed' }>['payload'],
    { kind: 'full' }
>['reason'];
/**
 * Git reads a `git.changed` event covers for one Session.
 */
const SESSION_SCOPED_GIT_METHODS = [
    'git.summary',
    'git.overview',
    'git.diffDocument',
    'git.blame',
    'git.fileHead',
] as const satisfies readonly [CaxriMethod, ...CaxriMethod[]];

const PULL_REQUEST_MEMBERSHIP_REASONS: ReadonlySet<FullStateChangeReason> = new Set([
    'session.create',
    'session.unarchive',
    'terminal.moveToNewSession',
]);

interface PendingFileChangeBatch {
    changes: Map<string, 'create' | 'update' | 'delete'>;
    gitIgnoreRulesChanged: boolean;
    overflow: boolean;
    sessionId: string;
}

function isDirectoryAffected(
    directory: string | undefined,
    changes: readonly string[],
    isOverflow: boolean,
    hasGitIgnoreRulesChanged: boolean,
): boolean {
    if (isOverflow || hasGitIgnoreRulesChanged) return true;
    if (!directory) return changes.length > 0;
    return changes.some((path) => path === directory || parentDirectoryPath(path) === directory);
}

/**
 * Controlled-view reads use two context keys: `files.list` is cached per Project (`workbenchProjectId`) so Sessions of
 * the same Project share one tree, while the remaining reads stay Session-scoped
 * (`${sessionId}:${workbenchProjectId}`).
 */
function isControlledContextMatch(
    parameters: Record<string, unknown>,
    sessionIds: ReadonlySet<string> | undefined,
    workbenchProjectId: string | undefined,
): boolean {
    if (!sessionIds || !workbenchProjectId) return true;
    const contextKey = parameters.contextKey;
    if (typeof contextKey !== 'string') return true;
    if (contextKey === workbenchProjectId) return true;
    return [...sessionIds].some((sessionId) => contextKey === `${sessionId}:${workbenchProjectId}`);
}

function isControlledOperationMatch(
    queryKey: readonly unknown[],
    operations: ReadonlySet<string>,
    options: {
        changes?: readonly string[];
        context?: {
            kind: 'session';
            sessionId: string;
            workbenchProjectId: string;
        };
        overflow?: boolean;
        viewId?: string;
    } = {},
): boolean {
    const [, rawParameters] = queryKey;
    if (
        typeof rawParameters !== 'object' ||
        rawParameters === null ||
        !isQueryMethod(queryKey, CONTROLLED_VIEW_QUERY_METHOD)
    )
        return false;
    const parameters = rawParameters as Record<string, unknown>;
    if (
        (options.viewId !== undefined && parameters.viewId !== options.viewId) ||
        typeof parameters.operation !== 'string' ||
        !operations.has(parameters.operation) ||
        !isControlledContextMatch(
            parameters,
            options.context ? new Set([options.context.sessionId]) : undefined,
            options.context?.workbenchProjectId,
        )
    )
        return false;
    const changes = options.changes;
    if (!changes || changes.length === 0 || options.overflow) return true;
    if (parameters.operation !== 'files.list') return true;
    const arguments_ = parameters.arguments;
    if (typeof arguments_ !== 'object' || arguments_ === null) return true;
    const directory = (arguments_ as { directory?: unknown }).directory;
    return isDirectoryAffected(
        typeof directory === 'string' ? directory : undefined,
        changes,
        false,
        false,
    );
}

/**
 * Invalidates the Session-scoped Files reads that a `files.changed` event cheaply reflects: the direct `files.list`
 * listing behind the editor breadcrumb picker, and the Core Resource Explorer. Both consume the same Server authority,
 * so its durable event is the single invalidation source instead of an Extension Host echo. `files.browse` is not
 * listed: the Path Browser is owned by Desktop Main (`path-browser-authority.ts`), which calls Server directly, so no
 * `files.browse` query is ever cached in the Renderer for a predicate to match. `projectStatus.summary` and
 * `projectStatus.overview` are excluded: a Project Status read may shell out to a delivery CLI (e.g. `gh`), so a plain
 * file write never invalidates it. Those two queries instead follow the Server's own delivery push
 * (`projectStatus.changed`, `sessionPullRequests.changed` — see `invalidateProjectStatusQuery` and
 * `invalidateSessionPullRequestDependentQueries` below) plus a low-frequency fallback poll on the status bar's own
 * side, for the same reason `git.changed` replaces polling for Git reads below. Git status/diff/blame queries
 * (`git.summary`, `git.overview`, `git.diffDocument`, `git.blame`) are no longer invalidated from here: a plain file
 * write does not always mean the working tree changed (e.g. an ignored file), so Git invalidation instead rides the
 * Server-emitted `git.changed` event, which is scoped to the repository identities that actually changed — see
 * `invalidateGitChangedQueries` below.
 */
function invalidateFileDependentQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
    workbenchProjectId: string,
    batch: PendingFileChangeBatch,
): void {
    const sessionIdSet = new Set(sessionIds);
    const changes = batch.changes.keys().toArray();
    // Fire-and-forget: the invalidated queries surface their own errors through React Query's
    // per-query error state, so the caller never needs to await or handle this rejection.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { directory?: string; sessionId?: string } | undefined,
            ];
            const isDirectFileListingMatch =
                isQueryMethod(query.queryKey, 'files.list') &&
                parameters?.sessionId !== undefined &&
                sessionIdSet.has(parameters.sessionId) &&
                isDirectoryAffected(
                    parameters.directory,
                    changes,
                    batch.overflow,
                    batch.gitIgnoreRulesChanged,
                );
            if (isDirectFileListingMatch) return true;
            /*
             * The Project search overlay is not a controlled view: it caches under the flat
             * `['files.search', `${sessionId}:${workbenchProjectId}`, options]` key `projectSearchQueryKey` builds.
             * Any write anywhere in the Project can add or drop a hit, so the whole scope is invalidated rather than
             * one directory — an open search would otherwise keep listing matches at paths that no longer hold them.
             */
            if (
                isQueryMethod(query.queryKey, 'files.search') &&
                sessionIds.some(
                    (sessionId) => query.queryKey[1] === `${sessionId}:${workbenchProjectId}`,
                )
            )
                return true;
            return sessionIds.some((sessionId) =>
                isControlledOperationMatch(query.queryKey, RESOURCE_EXPLORER_READ_OPERATIONS, {
                    context: { kind: 'session', sessionId, workbenchProjectId },
                    changes,
                    overflow: batch.overflow || batch.gitIgnoreRulesChanged,
                }),
            );
        },
    });
}

/**
 * Invalidates the Session-scoped Git read queries a `git.changed` event covers: status/topology (`git.summary`,
 * `git.overview`), file diffs (`git.diffDocument`), and blame annotations (`git.blame`, `git.fileHead`). Unlike
 * {@link invalidateFileDependentQueries}, this runs unconditionally on every `git.changed` push — the Server already
 * coalesces bursts of repository activity into one event before emitting it, so no additional client-side debounce is
 * needed here.
 */
function invalidateGitChangedQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    // Fire-and-forget: see the justification in invalidateFileDependentQueries above.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, ...SESSION_SCOPED_GIT_METHODS) &&
                parameters?.sessionId !== undefined &&
                sessionIds.includes(parameters.sessionId)
            );
        },
    });
}

/**
 * Invalidates both Project Status reads for one Session after `projectStatus.changed` — the Status panel's
 * `projectStatus.summary` and the status bar's `projectStatus.overview`. The two reads are computed independently, but
 * a summary refresh warms the same shared `GitHubPullRequestStore`/`LinearIssueStore`/`AcceptanceStore` records the
 * overview reads from (see `ProjectStatusService` in `apps/server/src/domains/project-status.ts`), so this refetch
 * normally costs no extra delivery-CLI call. This is what lets the status bar converge with the Status panel in the
 * same Server refresh instead of waiting out its own poll (issue caxri#1310).
 */
function invalidateProjectStatusQuery(queryClient: QueryClient, sessionId: string): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'projectStatus.summary', 'projectStatus.overview') &&
                parameters?.sessionId === sessionId
            );
        },
    });
}

/**
 * Invalidates the shared `session.pullRequests` sidebar query and the affected Sessions' `projectStatus.overview` read
 * after `sessionPullRequests.changed`. `SessionPullRequestService` and `ProjectStatusService` share one
 * `GitHubPullRequestStore` (see `service-handlers.ts`), so the overview's own pull-request resolution normally answers
 * from the record this sweep just wrote rather than paying for another `gh pr view` (issue caxri#1310).
 */
function invalidateSessionPullRequestDependentQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({ queryKey: PULL_REQUESTS_QUERY_KEY });
    const sessionIdSet = new Set(sessionIds);
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'projectStatus.overview') &&
                parameters?.sessionId !== undefined &&
                sessionIdSet.has(parameters.sessionId)
            );
        },
    });
}

/**
 * Refreshes one Session's "Always allow in this Session" read (issue caxri#1295) after its own
 * `agent.permissionAutoAllowChanged` transition, so the Session row menu shows the current grant whether it changed
 * from this window, another window, or a mobile device.
 */
function invalidatePermissionAutoAllowQuery(queryClient: QueryClient, sessionId: string): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'session.permissionAutoAllowStatus') &&
                parameters?.sessionId === sessionId
            );
        },
    });
}

/**
 * Refreshes the review comments for one Session + repository, and the cross-repository pending summary, after their own
 * `gitReview.changed` event — the Monaco bindings (`git-review-comment-binding.ts`) and the pending-comments
 * command/quit reminder both read through React Query rather than owning any comment state themselves.
 */
function invalidateGitReviewQueries(
    queryClient: QueryClient,
    sessionId: string,
    repoId: string,
): void {
    // Fire-and-forget: the refreshed queries surface any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { repositoryId?: string; sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'gitReview.list') &&
                parameters?.sessionId === sessionId &&
                parameters.repositoryId === repoId
            );
        },
    });
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({ queryKey: GIT_REVIEW_PENDING_QUERY_KEY });
}

/**
 * Re-asks the Server for delivery status after a settings write. `projectStatus.ignoredChecks` decides which checks the
 * Status panel rollup and the sidebar CI badge aggregate, and both are served from Server-side caches that survive for
 * minutes, so an edit would otherwise keep showing the pre-change rollup. The Server compares the rules before spending
 * anything, so a settings write that leaves them alone answers from cache.
 */
function invalidateDeliveryStatusQueries(queryClient: QueryClient): void {
    // Fire-and-forget: the refreshed queries surface any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            return isQueryMethod(query.queryKey, 'projectStatus.summary', 'session.pullRequests');
        },
    });
}

function invalidateAgentTranscriptQuery(queryClient: QueryClient, terminalId?: string): void {
    // Fire-and-forget: an active transcript viewer renders the refetch result through its query state.
    // eslint-disable-next-line no-void -- targeted query invalidation owns its own error state
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { terminalId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'terminal.agentTranscript') &&
                (terminalId === undefined || parameters?.terminalId === terminalId)
            );
        },
    });
}

/**
 * Drops every cached query keyed to one of `sessionIds` from the React Query cache. Called once a Session (or, with
 * every Session of a Project, a Project) is deleted — otherwise the cached reads (Git status, diffs, blame, file
 * listings, ...) linger under the removed sessionId until the default garbage collector reclaims them, even though the
 * Session can never be selected again. Unlike {@link invalidateFileDependentQueries}, this matches any method: a deleted
 * Session's data should never resurface, not just the file-dependent subset.
 */
export function removeSessionQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    if (sessionIds.length === 0) return;
    const removedSessionIds = new Set(sessionIds);
    queryClient.removeQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { contextKey?: string; sessionId?: string } | undefined,
            ];
            if (parameters?.sessionId !== undefined)
                return removedSessionIds.has(parameters.sessionId);
            /**
             * Controlled views and Extension Trees identify their Session through the `${sessionId}:...` context key
             * rather than a `sessionId` parameter, so the sweep has to recognize both shapes — otherwise a deleted
             * Session's cached views survive until garbage collection, which the Extension Tree deliberately delays.
             */
            const contextKey = parameters?.contextKey;
            if (contextKey === undefined) return false;
            return removedSessionIds
                .values()
                .some((sessionId) => contextKey.startsWith(`${sessionId}:`));
        },
    });
}

/**
 * `files.exclude` is global, so any valid settings reload refreshes every visible tree listing.
 */
function invalidateFileTreeQueries(queryClient: ReturnType<typeof useQueryClient>): void {
    // Fire-and-forget: see the justification in invalidateFileDependentQueries above.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { operation?: ControlledViewQueryOperation } | undefined,
            ];
            return (
                // The Project search overlay caches under a flat `['files.search', scopeId, options]` key of its own,
                // so it needs its own arm here: a search left open while an Agent writes files would otherwise keep
                // listing hits at paths that no longer contain them.
                isQueryMethod(query.queryKey, 'files.list', 'files.search') ||
                (isQueryMethod(query.queryKey, CONTROLLED_VIEW_QUERY_METHOD) &&
                    parameters?.operation === 'files.list')
            );
        },
    });
}

function invalidateControlledViewQueries(queryClient: QueryClient): void {
    // A reconnect or catalog generation change retires provider registrations. Refetching generic controlled queries
    // lets active observers resolve the new generation instead of reusing an old provider result.
    // eslint-disable-next-line no-void -- invalidation is intentionally fire-and-forget
    void queryClient.invalidateQueries({
        predicate: (query) => isQueryMethod(query.queryKey, CONTROLLED_VIEW_QUERY_METHOD),
    });
    /**
     * Extension Tree branches are dropped rather than invalidated: their cached items are addressed by opaque provider
     * handles, and a retired registration invalidates the handles themselves, so restoring them into the next mount
     * would replay tokens the provider can no longer resolve.
     */
    queryClient.removeQueries({
        predicate: (query) => isQueryMethod(query.queryKey, EXTENSION_TREE_CHILDREN_QUERY_METHOD),
    });
}

/**
 * Agent Action results already include provider settings. Drop them after a valid settings write so reopening the
 * picker starts from the current Renderer fallback instead of briefly rendering cached pre-write overrides.
 */
function removeAgentActionQueries(queryClient: QueryClient): void {
    queryClient.removeQueries({ queryKey: AGENT_ACTIONS_QUERY_KEY });
}

/**
 * Wires `caxri.onEvent` runtime pushes to targeted query invalidation. Mounted once at the app root (see `app.tsx`)
 * alongside the existing Zustand `subscribeWorkbenchEvents` wiring — Session/Project bootstrap state stays on that
 * push-based Zustand path; this hook only owns the request/response reads that moved to React Query.
 */
export function useRuntimeQueryInvalidation(): void {
    const queryClient = useQueryClient();
    useEffect(() => subscribeRuntimeQueryInvalidation(queryClient), [queryClient]);
}

/**
 * Subscribes the query cache to Server events. The debounce is keyed by Workbench Project rather than source Session
 * because every Session currently routed to that root observes the same disk.
 */
export function subscribeRuntimeQueryInvalidation(queryClient: QueryClient): () => void {
    const pendingTimers = new Map<string, number>();
    const pendingBatches = new Map<string, PendingFileChangeBatch>();
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'viewContainers.catalogChanged') {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, React Query owns invalidation errors
            void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
            invalidateControlledViewQueries(queryClient);
            return;
        }
        /**
         * `viewContainers.treeChanged` is deliberately absent here: a mounted Extension Tree replays the changed
         * branches itself (see `useExtensionTreeChildren`) and writes the result back into the cache, and an unmounted
         * one revalidates its root on the next mount. Invalidating from here would only race that owner.
         */
        if (
            event.event === 'viewContainers.viewChanged' &&
            (event.payload.change.kind === 'content' || event.payload.change.kind === 'badge')
        ) {
            const context =
                event.payload.context.kind === 'session' ? event.payload.context : undefined;
            if (!context) return;
            // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
            void queryClient.invalidateQueries({
                predicate: (query) =>
                    isControlledOperationMatch(
                        query.queryKey,
                        event.payload.change.kind === 'badge'
                            ? BADGE_OPERATIONS
                            : SOURCE_CONTROL_CONTENT_OPERATIONS,
                        {
                            viewId: event.payload.viewId,
                            context,
                        },
                    ),
            });
            return;
        }
        if (event.event === 'state.changed') {
            // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
            void queryClient.invalidateQueries({ queryKey: COMMANDER_STATUS_QUERY_KEY });
            if (event.payload.kind === 'full') invalidateAgentTranscriptQuery(queryClient);
            else {
                for (const terminalId of event.payload.terminalIds)
                    invalidateAgentTranscriptQuery(queryClient, terminalId);
            }
            if (event.payload.kind === 'full' && event.payload.reason === 'unknown') {
                /**
                 * Snapshot recovery intentionally replaces private changefeed payloads with one full invalidation.
                 * Refetch every mounted read so Files, Git, settings-derived actions, and extension projections all
                 * converge without persisting the original configuration source, path, or failure message.
                 */
                removeAgentActionQueries(queryClient);
                // eslint-disable-next-line no-void -- React Query owns each refetch result and error state.
                void queryClient.invalidateQueries();
            }
            /**
             * The Server sweeps pull requests only when a snapshot is requested, and the sidebar otherwise re-asks on a
             * one-minute poll. Membership changes must refresh that shared query immediately.
             */
            if (
                event.payload.kind === 'full' &&
                PULL_REQUEST_MEMBERSHIP_REASONS.has(event.payload.reason)
            ) {
                // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
                void queryClient.invalidateQueries({ queryKey: PULL_REQUESTS_QUERY_KEY });
            }
            return;
        }
        if (event.event === 'host.connectionChanged') {
            /**
             * A recovery snapshot can replace an overrun durable-event window. Refetch every mounted transcript after
             * reconnect so a changed file still converges even when its targeted invalidation fell outside the
             * journal.
             */
            invalidateAgentTranscriptQuery(queryClient);
            // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
            void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
            invalidateControlledViewQueries(queryClient);
            return;
        }
        if (event.event === 'workbench.changed') {
            removeSessionQueries(queryClient, [event.payload.sessionId]);
            // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle.
            void queryClient.invalidateQueries({ queryKey: PULL_REQUESTS_QUERY_KEY });
            return;
        }
        if (event.event === 'settings.changed') {
            if (!event.payload.error) {
                invalidateFileTreeQueries(queryClient);
                removeAgentActionQueries(queryClient);
                invalidateDeliveryStatusQueries(queryClient);
            }
            return;
        }
        if (event.event === 'git.changed') {
            invalidateGitChangedQueries(queryClient, event.payload.sessionIds);
            return;
        }
        if (event.event === 'projectStatus.changed') {
            invalidateProjectStatusQuery(queryClient, event.payload.sessionId);
            return;
        }
        if (event.event === 'agent.permissionAutoAllowChanged') {
            invalidatePermissionAutoAllowQuery(queryClient, event.payload.sessionId);
            return;
        }
        if (event.event === 'gitReview.changed') {
            invalidateGitReviewQueries(
                queryClient,
                event.payload.sessionId,
                event.payload.repositoryId,
            );
            return;
        }
        if (event.event === 'sessionPullRequests.changed') {
            invalidateSessionPullRequestDependentQueries(queryClient, event.payload.sessionIds);
            return;
        }
        if (event.event === 'agentTranscript.changed') {
            invalidateAgentTranscriptQuery(queryClient, event.payload.terminalId);
            return;
        }
        if (event.event !== 'files.changed') return;
        const { sessionId, workbenchProjectId } = event.payload;
        const batch =
            pendingBatches.get(workbenchProjectId) ??
            ({
                changes: new Map(),
                gitIgnoreRulesChanged: false,
                overflow: false,
                sessionId,
            } satisfies PendingFileChangeBatch);
        for (const change of event.payload.changes) batch.changes.set(change.path, change.kind);
        batch.gitIgnoreRulesChanged ||= event.payload.gitIgnoreRulesChanged === true;
        batch.overflow ||= event.payload.overflow;
        batch.sessionId = sessionId;
        pendingBatches.set(workbenchProjectId, batch);
        const existing = pendingTimers.get(workbenchProjectId);
        if (existing !== undefined) clearTimeout(existing);
        pendingTimers.set(
            workbenchProjectId,
            setTimeout(() => {
                pendingTimers.delete(workbenchProjectId);
                const pending = pendingBatches.get(workbenchProjectId);
                pendingBatches.delete(workbenchProjectId);
                if (!pending) return;
                invalidateFileDependentQueries(
                    queryClient,
                    getWorkbenchProjectSessionIds(workbenchProjectId, pending.sessionId),
                    workbenchProjectId,
                    pending,
                );
            }, FILE_CHANGE_INVALIDATION_DEBOUNCE_MS),
        );
    });
    return () => {
        unsubscribe();
        for (const timer of pendingTimers.values()) clearTimeout(timer);
        pendingBatches.clear();
    };
}
