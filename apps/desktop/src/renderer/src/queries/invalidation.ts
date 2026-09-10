import { useEffect } from 'react';

import type { CaxriMethod } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';

import { caxri } from '../lib/caxri';
import { parentDirectoryPath } from '../lib/file-path';
import { getWorkbenchProjectSessionIds } from '../stores/selectors';

/**
 * Debounce window used to coalesce a burst of `files.changed` events into one invalidation pass.
 */
const FILE_CHANGE_INVALIDATION_DEBOUNCE_MS = 150;

const RESOURCE_EXPLORER_READ_OPERATIONS = new Set([
    'files.list',
    'files.search',
    'files.operation.get',
    'files.operation.list',
]);
const SOURCE_CONTROL_CONTENT_OPERATIONS = new Set(['source.snapshot']);
const BADGE_OPERATIONS = new Set(['badge.snapshot']);

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
    const [method, rawParameters] = queryKey;
    if (
        method !== 'viewContainers.viewOperation' ||
        typeof rawParameters !== 'object' ||
        rawParameters === null
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
    if (parameters.operation === 'files.search') return true;
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
 * Invalidates the Session-scoped Files reads that a `files.changed` event cheaply reflects: the Path Browser and the
 * Core Resource Explorer. Both consume the same Server authority, so its durable event is the single invalidation
 * source instead of an Extension Host echo. `projectStatus.summary` and `projectStatus.overview` are excluded: a
 * Project Status read may shell out to a delivery CLI (e.g. `gh`), so it stays on its own polling interval instead of
 * re-running on every file write. Git status/diff/blame queries (`git.summary`, `git.overview`, `git.diffDocument`,
 * `git.blame`) are no longer invalidated from here: a plain file write does not always mean the working tree changed
 * (e.g. an ignored file), so Git invalidation instead rides the Server-emitted `git.changed` event, which is scoped to
 * the repository identities that actually changed — see `invalidateGitChangedQueries` below.
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
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { directory?: string; sessionId?: string } | undefined,
            ];
            const isPathBrowserMatch =
                method === 'files.browse' &&
                parameters?.sessionId !== undefined &&
                sessionIdSet.has(parameters.sessionId) &&
                isDirectoryAffected(
                    parameters.directory,
                    changes,
                    batch.overflow,
                    batch.gitIgnoreRulesChanged,
                );
            if (isPathBrowserMatch) return true;
            const isDirectFileListingMatch =
                method === 'files.list' &&
                parameters?.sessionId !== undefined &&
                sessionIdSet.has(parameters.sessionId) &&
                isDirectoryAffected(
                    parameters.directory,
                    changes,
                    batch.overflow,
                    batch.gitIgnoreRulesChanged,
                );
            if (isDirectFileListingMatch) return true;
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
    const sessionScoped = new Set<CaxriMethod>([
        'git.summary',
        'git.overview',
        'git.diffDocument',
        'git.blame',
        'git.fileHead',
    ]);
    // Fire-and-forget: see the justification in invalidateFileDependentQueries above.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                sessionScoped.has(method) &&
                parameters?.sessionId !== undefined &&
                sessionIds.includes(parameters.sessionId)
            );
        },
    });
}

function invalidateProjectStatusQuery(queryClient: QueryClient, sessionId: string): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return method === 'projectStatus.summary' && parameters?.sessionId === sessionId;
        },
    });
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
            const [method] = query.queryKey as [CaxriMethod];
            return method === 'projectStatus.summary' || method === 'session.pullRequests';
        },
    });
}

function invalidateAgentTranscriptQuery(queryClient: QueryClient, terminalId?: string): void {
    // Fire-and-forget: an active transcript viewer renders the refetch result through its query state.
    // eslint-disable-next-line no-void -- targeted query invalidation owns its own error state
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { terminalId?: string } | undefined,
            ];
            return (
                method === 'terminal.agentTranscript' &&
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
                { sessionId?: string } | undefined,
            ];
            return (
                parameters?.sessionId !== undefined && removedSessionIds.has(parameters.sessionId)
            );
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
            const [method, parameters] = query.queryKey as [
                string,
                { operation?: string } | undefined,
            ];
            return (
                method === 'files.browse' ||
                method === 'files.list' ||
                (method === 'viewContainers.viewOperation' &&
                    (parameters?.operation === 'files.list' ||
                        parameters?.operation === 'files.search'))
            );
        },
    });
}

function invalidateControlledViewQueries(queryClient: QueryClient): void {
    // A reconnect or catalog generation change retires provider registrations. Refetching generic controlled queries
    // lets active observers resolve the new generation instead of reusing an old provider result.
    // eslint-disable-next-line no-void -- invalidation is intentionally fire-and-forget
    void queryClient.invalidateQueries({
        predicate: (query) =>
            query.queryKey[0] === 'viewContainers.viewOperation' ||
            query.queryKey[0] === 'viewContainers.treeChildren',
    });
}

/**
 * Agent Action results already include provider settings. Drop them after a valid settings write so reopening the
 * picker starts from the current Renderer fallback instead of briefly rendering cached pre-write overrides.
 */
function removeAgentActionQueries(queryClient: QueryClient): void {
    queryClient.removeQueries({ queryKey: ['agentActions.list'] });
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
            void queryClient.invalidateQueries({ queryKey: ['viewContainers.catalog'] });
            invalidateControlledViewQueries(queryClient);
            return;
        }
        if (event.event === 'viewContainers.treeChanged') {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, React Query owns invalidation errors
            void queryClient.invalidateQueries({
                predicate: (query) => {
                    const [method, parameters] = query.queryKey as [
                        CaxriMethod,
                        { viewId?: string } | undefined,
                    ];
                    return (
                        method === 'viewContainers.treeChildren' &&
                        parameters?.viewId === event.payload.viewId
                    );
                },
            });
            return;
        }
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
             * one-minute poll, so a new Session's PR glyph would sit blank for up to a minute after creation.
             */
            if (event.payload.kind === 'full' && event.payload.reason === 'session.create') {
                // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
                void queryClient.invalidateQueries({ queryKey: ['session.pullRequests'] });
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
            void queryClient.invalidateQueries({ queryKey: ['viewContainers.catalog'] });
            invalidateControlledViewQueries(queryClient);
            return;
        }
        if (event.event === 'workbench.changed') {
            removeSessionQueries(queryClient, [event.payload.sessionId]);
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
        if (event.event === 'sessionPullRequests.changed') {
            // Fire-and-forget: the refreshed query surfaces any error through React Query state.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void queryClient.invalidateQueries({ queryKey: ['session.pullRequests'] });
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
