import { stat } from 'node:fs/promises';

import type {
    AgentProvider,
    SessionImportConversationResult,
    SessionSearchIndexStatus,
    SessionSearchParameters,
    SessionSearchPreviewParameters,
    SessionSearchPreviewResult,
    SessionSearchRelaxation,
    SessionSearchResult,
} from '@caxri/protocol';
import { CaxriError, MAX_SESSION_SEARCH_RESULTS } from '@caxri/protocol';

import type { IndexSearchResponse, InspectedConversation, SessionSearchIndex } from '../agents';
import {
    conversationKey,
    metadataMatch,
    parseSessionOperators,
    parseSessionQuery,
    SessionSearchIndexUnavailableError,
} from '../agents';
import type { CaxriDatabase } from '../db';
import type { WorktreeTopologyReader } from './import-conversation';
import { importExternalConversation, isInside, OUTSIDE_SCOPE_MESSAGE } from './import-conversation';
import type { HeldConversation, Holdings, RankedEntry, SearchScope } from './search-entries';
import {
    compareRanked,
    externalEntry,
    heldEntry,
    scopedHoldings,
    sessionEntry,
    sessionStatus,
} from './search-entries';
import { collapseForkGroups, keepForkIdentity } from './search-fork-groups';

/**
 * Index hits requested per search: several conversations can fold into one Session row, so ask for more than one page.
 */
const INDEX_RESULT_LIMIT = MAX_SESSION_SEARCH_RESULTS * 2;

const unavailableIndex: SessionSearchIndexStatus = {
    state: 'unavailable',
    conversations: 0,
    pending: 0,
};

export async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

function isAbort(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/**
 * Session search across every Agent conversation on this machine: Caxri's own Sessions (open and archived) by title,
 * ID, and folder, plus every provider transcript in the background index by content too. A conversation a Session holds
 * is reported as that Session, so one Session is one row however many conversations it rotated through.
 */
export class SessionSearchService {
    constructor(
        private readonly options: {
            database: CaxriDatabase;
            index: Pick<SessionSearchIndex, 'inspect' | 'preview' | 'search'>;
            resolveProjectRoot: (path: string) => Promise<string>;
            onSessionImported: () => void;
            /**
             * Folders where Caxri runs its own Agents, such as Caxri Bot's workspace. A conversation there is never the
             * user's own, so it is neither listed as external nor imported. Matching the folder rather than the hidden
             * Session keeps it out after a clean-install cutoff drops that Session.
             */
            internalRoots?: readonly string[];
            readTopology?: WorktreeTopologyReader;
        },
    ) {}

    private isInternal(cwd: string | undefined): boolean {
        return (
            cwd !== undefined &&
            (this.options.internalRoots ?? []).some((root) => isInside(cwd, root))
        );
    }

    private async searchIndex(
        scope: SearchScope,
        status: NonNullable<SessionSearchParameters['status']>,
        holdings: Holdings,
        signal: AbortSignal | undefined,
    ): Promise<
        | IndexSearchResponse
        | {
              hits: [];
              status: SessionSearchIndexStatus;
              usedSubstringScan: boolean;
              relaxation: SessionSearchRelaxation;
          }
    > {
        const heldKeys = (isKept: (held: HeldConversation) => boolean) =>
            holdings.byKey
                .entries()
                .filter(([, held]) => isKept(held))
                .map(([key]) => key)
                .toArray();
        const restrict =
            status === 'all'
                ? { mode: 'exclude' as const, keys: [...holdings.hiddenKeys] }
                : status === 'external'
                  ? {
                        mode: 'exclude' as const,
                        keys: [...holdings.byKey.keys(), ...holdings.hiddenKeys],
                    }
                  : {
                        mode: 'include' as const,
                        keys: heldKeys(
                            (held) =>
                                status === 'caxri' || sessionStatus(held.session) === 'archived',
                        ),
                    };
        try {
            return await this.options.index.search(
                {
                    query: scope.text,
                    ...(scope.providers && { providers: scope.providers }),
                    ...(scope.filters.projects.length > 0 && { projects: scope.filters.projects }),
                    ...(scope.beforeMs !== undefined && { beforeMs: scope.beforeMs }),
                    ...(scope.afterMs !== undefined && { afterMs: scope.afterMs }),
                    ...(scope.current && { preferredRoot: scope.current.rootPath }),
                    restrict,
                    heldKeys: holdings.byKey.keys().toArray(),
                    limit: INDEX_RESULT_LIMIT,
                },
                signal,
            );
        } catch (error) {
            if (isAbort(signal)) throw error;
            if (!(error instanceof SessionSearchIndexUnavailableError)) throw error;
            return {
                hits: [],
                status: unavailableIndex,
                usedSubstringScan: false,
                relaxation: 'phrase',
            };
        }
    }

    /**
     * Visible Sessions matching on their own title, ID, or Workbench root. Covers a Session the index cannot see: a
     * Shell-only one, one whose Agent has not written a transcript yet, or one the user renamed.
     */
    private sessionEntries(
        scope: SearchScope,
        status: NonNullable<SessionSearchParameters['status']>,
        holdings: Holdings,
        relaxation: SessionSearchRelaxation,
    ): RankedEntry[] {
        const { terms } = parseSessionQuery(scope.text);
        const allowedProviders = scope.providers && new Set(scope.providers);
        return this.options.database.listVisibleSessions().flatMap((session) => {
            if (scope.projects && !scope.projects.has(session.projectId)) return [];
            if (status === 'archived' && session.archivedAt === undefined) return [];
            if (
                (scope.beforeMs !== undefined && session.sessionActivityAt >= scope.beforeMs) ||
                (scope.afterMs !== undefined && session.sessionActivityAt < scope.afterMs)
            )
                return [];
            if (
                scope.filters.projects.length > 0 &&
                scope.filters.projects.every(
                    (project) => !session.rootPath.toLowerCase().includes(project),
                )
            )
                return [];
            const conversations = holdings.bySession.get(session.id) ?? [];
            if (
                allowedProviders &&
                conversations.every((held) => !allowedProviders.has(held.provider))
            )
                return [];
            const primary = conversations[0];
            const updatedAt = Math.trunc(session.sessionActivityAt);
            if (terms.length === 0)
                return [
                    {
                        entry: sessionEntry(session, primary, 'recent', updatedAt),
                        score: updatedAt,
                        ...(scope.current?.id === session.projectId && {
                            isCurrentProject: true,
                        }),
                    },
                ];
            const field = metadataMatch(
                terms,
                {
                    title: session.title,
                    cwd: session.rootPath,
                    ids: [session.id, ...conversations.map((held) => held.agentSessionId)],
                },
                // Session titles join the any-word step only once the index has relaxed, so both sources agree.
                relaxation === 'anyWord' ? 'any' : 'all',
            );
            return field
                ? [
                      {
                          entry: sessionEntry(session, primary, field, updatedAt),
                          score: updatedAt,
                          ...(scope.current?.id === session.projectId && {
                              isCurrentProject: true,
                          }),
                      },
                  ]
                : [];
        });
    }

    /**
     * Which provider conversations each Session holds: every Terminal's current binding, plus the usage ledger's record
     * of conversations a Session hosted before `/clear` or a closed Terminal replaced the binding.
     */
    private holdings(): Holdings {
        const { database } = this.options;
        const visible = new Map(
            database.listVisibleSessions().map((session) => [session.id, session]),
        );
        const holdings: Holdings = {
            byKey: new Map(),
            bySession: new Map(),
            hiddenKeys: new Set(),
        };
        const hold = (
            sessionId: string,
            provider: AgentProvider,
            agentSessionId: string,
            isPrimary: boolean,
        ) => {
            const key = conversationKey(provider, agentSessionId);
            if (holdings.byKey.has(key) || holdings.hiddenKeys.has(key)) return;
            const session = visible.get(sessionId);
            if (!session) {
                if (database.getSession(sessionId)) holdings.hiddenKeys.add(key);
                return;
            }
            const held = { session, provider, agentSessionId };
            holdings.byKey.set(key, held);
            const list = holdings.bySession.get(sessionId) ?? [];
            if (isPrimary) list.unshift(held);
            else list.push(held);
            holdings.bySession.set(sessionId, list);
        };
        for (const terminal of database.listTerminals()) {
            if (!terminal.provider || !terminal.agentSessionId) continue;
            const isPrimary =
                visible.get(terminal.sessionId)?.primaryAgentTerminalId === terminal.id;
            hold(terminal.sessionId, terminal.provider, terminal.agentSessionId, isPrimary);
        }
        for (const row of database.agentSessionUsage.list())
            hold(row.sessionId, row.provider, row.agentSessionId, false);
        return holdings;
    }

    /**
     * Resolves the query's operators, the `providers` parameter, and the current-Project hint into one scope.
     */
    private scopeOf(
        parameters: SessionSearchParameters,
        projectScope: readonly string[] | undefined,
    ): SearchScope {
        const operators = parseSessionOperators(parameters.query);
        const requested = parameters.providers?.length ? parameters.providers : undefined;
        const operatorAgents = operators.filters.agents;
        const requestedSet = new Set(requested);
        const providers =
            operatorAgents.length === 0
                ? requested
                : // Both a filter button and an `agent:` operator narrow the search, so only their overlap remains.
                  operatorAgents.filter((agent) => !requested || requestedSet.has(agent));
        const project =
            parameters.currentProjectId === undefined ||
            (projectScope && !projectScope.includes(parameters.currentProjectId))
                ? undefined
                : this.options.database.getProject(parameters.currentProjectId);
        return {
            text: operators.text,
            filters: operators.filters,
            providers,
            ...(operators.beforeMs !== undefined && { beforeMs: operators.beforeMs }),
            ...(operators.afterMs !== undefined && { afterMs: operators.afterMs }),
            ...(project && { current: { id: project.id, rootPath: project.rootPath } }),
            ...(projectScope && { projects: new Set(projectScope) }),
        };
    }

    /**
     * A `projectScope` (a paired device's grant) limits the search to open and archived Sessions in those Projects:
     * `all` narrows to `caxri`, and `external` finds nothing.
     */
    async search(
        parameters: SessionSearchParameters,
        signal?: AbortSignal,
        projectScope?: readonly string[],
    ): Promise<SessionSearchResult> {
        const requested = parameters.status ?? 'all';
        const status = projectScope && requested === 'all' ? 'caxri' : requested;
        const scope = this.scopeOf(parameters, projectScope);
        // `agent:` operators that exclude every requested provider leave nothing to search.
        if (scope.providers?.length === 0 || (projectScope && status === 'external'))
            return {
                entries: [],
                index: unavailableIndex,
                usedSubstringScan: false,
                filters: scope.filters,
                relaxation: 'phrase',
            };
        const holdings = scope.projects
            ? scopedHoldings(this.holdings(), scope.projects)
            : this.holdings();
        let index = await this.searchIndex(scope, status, holdings, signal);
        let { relaxation } = index;
        let sessions =
            status === 'external' ? [] : this.sessionEntries(scope, status, holdings, relaxation);
        if (relaxation === 'anyWord') {
            // A Session whose own title already holds every word is a strict match; relaxing only fills a void.
            const strict = this.sessionEntries(scope, status, holdings, 'phrase');
            if (status !== 'external' && strict.length > 0) {
                sessions = strict;
                index = { ...index, hits: [] };
                relaxation = 'allWords';
            }
        }
        if (relaxation === 'phrase' && index.hits.length === 0 && sessions.length === 0) {
            // Neither source holds every word: a Session whose own title holds one of them still answers.
            const loosened =
                status === 'external'
                    ? []
                    : this.sessionEntries(scope, status, holdings, 'anyWord');
            if (loosened.length > 0 && parseSessionQuery(scope.text).terms.length > 1) {
                sessions = loosened;
                relaxation = 'anyWord';
            }
        }
        const ranked = new Map<string, RankedEntry>();
        const offer = (key: string, candidate: RankedEntry) => {
            const existing = ranked.get(key);
            if (!existing || compareRanked(candidate, existing) < 0)
                ranked.set(key, existing ? keepForkIdentity(candidate, existing) : candidate);
        };
        const isInWindow = (updatedAt: number) =>
            (scope.beforeMs === undefined || updatedAt < scope.beforeMs) &&
            (scope.afterMs === undefined || updatedAt >= scope.afterMs);
        for (const hit of index.hits) {
            const held = holdings.byKey.get(hit.key);
            if (held) {
                const candidate = heldEntry(held, hit, scope);
                if (isInWindow(candidate.entry.updatedAt))
                    offer(`session:${held.session.id}`, candidate);
            } else if (
                !scope.projects &&
                !holdings.hiddenKeys.has(hit.key) &&
                !this.isInternal(hit.cwd)
            )
                offer(hit.key, externalEntry(hit, scope));
        }
        for (const entry of sessions) offer(`session:${entry.entry.sessionId}`, entry);
        return {
            entries: collapseForkGroups(ranked.values().toArray().toSorted(compareRanked))
                .slice(0, MAX_SESSION_SEARCH_RESULTS)
                .map(({ entry, isCurrentProject }) =>
                    isCurrentProject ? { ...entry, isCurrentProject: true as const } : entry,
                ),
            index: index.status,
            usedSubstringScan: index.usedSubstringScan,
            filters: scope.filters,
            relaxation,
        };
    }

    /**
     * The search dialog's preview of one conversation. Read-only and answered from the index, so previewing an external
     * conversation creates no Session and writes nothing to Caxri's database.
     */
    async preview(
        parameters: SessionSearchPreviewParameters,
        signal?: AbortSignal,
    ): Promise<SessionSearchPreviewResult> {
        try {
            // The operators select conversations; only the remaining words are matched inside one.
            return await this.options.index.preview(
                { ...parameters, query: parseSessionOperators(parameters.query).text },
                signal,
            );
        } catch (error) {
            if (error instanceof SessionSearchIndexUnavailableError && !isAbort(signal))
                throw new CaxriError('UNAVAILABLE', 'Session search is unavailable');
            throw error;
        }
    }

    /**
     * Adds an external conversation to Caxri as a new Session in the Project containing its folder. A conversation a
     * Session already holds returns that Session instead of a duplicate. A non-null `projectScope` (an Agent caller)
     * admits only a Session in one of those Projects and never adds a top-level Project.
     */
    async importConversation(
        provider: AgentProvider,
        agentSessionId: string,
        projectScope: readonly string[] | null = null,
    ): Promise<SessionImportConversationResult> {
        const { database } = this.options;
        const key = conversationKey(provider, agentSessionId);
        const holdings = this.holdings();
        const held = holdings.byKey.get(key);
        if (held) {
            if (projectScope && !projectScope.includes(held.session.projectId))
                throw new CaxriError('FORBIDDEN', OUTSIDE_SCOPE_MESSAGE);
            return { sessionId: held.session.id, projectId: held.session.projectId };
        }
        if (holdings.hiddenKeys.has(key))
            throw new CaxriError('CONFLICT', 'This conversation belongs to a hidden Session');
        let conversation: InspectedConversation | undefined;
        try {
            conversation = await this.options.index.inspect(provider, agentSessionId);
        } catch (error) {
            if (error instanceof SessionSearchIndexUnavailableError)
                throw new CaxriError('UNAVAILABLE', 'Session search is unavailable');
            throw error;
        }
        if (!conversation)
            throw new CaxriError('NOT_FOUND', 'The Agent no longer has this conversation');
        if (this.isInternal(conversation.cwd))
            throw new CaxriError('CONFLICT', 'This conversation belongs to Caxri Bot');
        const isFolder = await isDirectory(conversation.cwd);
        if (!isFolder)
            throw new CaxriError(
                'NOT_FOUND',
                'The folder this conversation ran in no longer exists',
            );
        const imported = await importExternalConversation(
            database,
            {
                provider,
                providerSessionId: agentSessionId,
                cwd: conversation.cwd,
                ...(conversation.title !== undefined && { title: conversation.title }),
            },
            this.options.resolveProjectRoot,
            this.options.readTopology,
            projectScope,
        );
        if (!imported)
            throw new CaxriError('PATH_DENIED', 'This folder cannot be added as a Project');
        this.options.onSessionImported();
        return { sessionId: imported.session.id, projectId: imported.session.projectId };
    }
}
