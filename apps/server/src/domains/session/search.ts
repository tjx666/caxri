import { stat } from 'node:fs/promises';

import type {
    AgentProvider,
    SessionImportConversationResult,
    SessionRecord,
    SessionSearchEntry,
    SessionSearchIndexStatus,
    SessionSearchParameters,
    SessionSearchResult,
    SessionSearchStatus,
} from '@caxri/protocol';
import { CaxriError, MAX_SESSION_SEARCH_RESULTS } from '@caxri/protocol';

import type {
    IndexedConversationHit,
    IndexSearchResponse,
    InspectedConversation,
    SessionSearchIndex,
} from '../agents';
import {
    compareHits,
    conversationKey,
    metadataMatch,
    parseSessionQuery,
    SessionSearchIndexUnavailableError,
} from '../agents';
import type { CaxriDatabase } from '../db';
import { importExternalConversation } from './import-conversation';

/**
 * Index hits requested per search: several conversations can fold into one Session row, so ask for more than one page.
 */
const INDEX_RESULT_LIMIT = MAX_SESSION_SEARCH_RESULTS * 2;
const MAX_TITLE_LENGTH = 1_024;

const unavailableIndex: SessionSearchIndexStatus = {
    state: 'unavailable',
    conversations: 0,
    pending: 0,
};

interface HeldConversation {
    session: SessionRecord;
    provider: AgentProvider;
    agentSessionId: string;
}

interface Holdings {
    /**
     * Provider conversations a visible Session holds, by `<provider>:<conversation id>`.
     */
    byKey: Map<string, HeldConversation>;
    /**
     * Each visible Session's conversations, its current Primary Agent binding first.
     */
    bySession: Map<string, HeldConversation[]>;
    /**
     * Conversations held by a Session in a hidden Project (such as the Commander's): never offered as external.
     */
    hiddenKeys: Set<string>;
}

interface RankedEntry {
    entry: SessionSearchEntry;
    score: number;
}

export async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

function sessionStatus(session: SessionRecord): SessionSearchStatus {
    return session.archivedAt === undefined ? 'open' : 'archived';
}

function bounded(title: string): string {
    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
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
            index: Pick<SessionSearchIndex, 'inspect' | 'search'>;
            resolveProjectRoot: (path: string) => Promise<string>;
            onSessionImported: () => void;
        },
    ) {}

    private async searchIndex(
        query: string,
        providers: AgentProvider[] | undefined,
        status: NonNullable<SessionSearchParameters['status']>,
        holdings: Holdings,
        signal: AbortSignal | undefined,
    ): Promise<
        | IndexSearchResponse
        | { hits: []; status: SessionSearchIndexStatus; usedSubstringScan: boolean }
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
                    query,
                    ...(providers && { providers }),
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
            };
        }
    }

    /**
     * Visible Sessions matching on their own title, ID, or Workbench root. Covers a Session the index cannot see: a
     * Shell-only one, one whose Agent has not written a transcript yet, or one the user renamed.
     */
    private sessionEntries(
        query: string,
        providers: readonly AgentProvider[] | undefined,
        status: NonNullable<SessionSearchParameters['status']>,
        holdings: Holdings,
    ): RankedEntry[] {
        const { terms } = parseSessionQuery(query);
        const allowedProviders = providers && new Set(providers);
        return this.options.database.listVisibleSessions().flatMap((session) => {
            if (status === 'archived' && session.archivedAt === undefined) return [];
            const conversations = holdings.bySession.get(session.id) ?? [];
            if (
                allowedProviders &&
                conversations.every((held) => !allowedProviders.has(held.provider))
            )
                return [];
            const primary = conversations[0];
            const updatedAt = Math.trunc(session.lastSessionActivityAt);
            if (terms.length === 0)
                return [
                    {
                        entry: sessionEntry(session, primary, 'recent', updatedAt),
                        score: updatedAt,
                    },
                ];
            const field = metadataMatch(terms, {
                title: session.displayTitle,
                cwd: session.rootPath,
                ids: [session.id, ...conversations.map((held) => held.agentSessionId)],
            });
            return field
                ? [{ entry: sessionEntry(session, primary, field, updatedAt), score: updatedAt }]
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

    async search(
        parameters: SessionSearchParameters,
        signal?: AbortSignal,
    ): Promise<SessionSearchResult> {
        const status = parameters.status ?? 'all';
        const providers = parameters.providers?.length ? parameters.providers : undefined;
        const holdings = this.holdings();
        const index = await this.searchIndex(parameters.query, providers, status, holdings, signal);
        const ranked = new Map<string, RankedEntry>();
        const offer = (key: string, candidate: RankedEntry) => {
            const existing = ranked.get(key);
            if (!existing || compareRanked(candidate, existing) < 0) ranked.set(key, candidate);
        };
        for (const hit of index.hits) {
            const held = holdings.byKey.get(hit.key);
            if (held) offer(`session:${held.session.id}`, heldEntry(held, hit));
            else if (!holdings.hiddenKeys.has(hit.key)) offer(hit.key, externalEntry(hit));
        }
        if (status !== 'external') {
            for (const entry of this.sessionEntries(parameters.query, providers, status, holdings))
                offer(`session:${entry.entry.sessionId}`, entry);
        }
        return {
            entries: ranked
                .values()
                .toArray()
                .toSorted(compareRanked)
                .slice(0, MAX_SESSION_SEARCH_RESULTS)
                .map(({ entry }) => entry),
            index: index.status,
            usedSubstringScan: index.usedSubstringScan,
        };
    }

    /**
     * Adds an external conversation to Caxri as a new Session in the Project containing its folder. A conversation a
     * Session already holds returns that Session instead of a duplicate.
     */
    async importConversation(
        provider: AgentProvider,
        agentSessionId: string,
    ): Promise<SessionImportConversationResult> {
        const { database } = this.options;
        const key = conversationKey(provider, agentSessionId);
        const holdings = this.holdings();
        const held = holdings.byKey.get(key);
        if (held) return { sessionId: held.session.id, projectId: held.session.projectId };
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
        );
        if (!imported)
            throw new CaxriError('PATH_DENIED', 'This folder cannot be added as a Project');
        this.options.onSessionImported();
        return { sessionId: imported.session.id, projectId: imported.session.projectId };
    }
}

function compareRanked(left: RankedEntry, right: RankedEntry): number {
    return compareHits(
        { field: left.entry.match.field, score: left.score },
        { field: right.entry.match.field, score: right.score },
    );
}

function matchOf(hit: IndexedConversationHit): SessionSearchEntry['match'] {
    return {
        field: hit.field,
        ...(hit.snippet && { snippet: hit.snippet }),
        ...(hit.messageCount !== undefined && { messageCount: hit.messageCount }),
    };
}

function heldEntry(held: HeldConversation, hit: IndexedConversationHit): RankedEntry {
    const updatedAt = Math.trunc(Math.max(hit.updatedAt, held.session.lastSessionActivityAt));
    return {
        entry: {
            ...sessionEntry(held.session, held, hit.field, updatedAt),
            ...(hit.cwd !== undefined && { cwd: hit.cwd }),
            match: matchOf(hit),
        },
        score: hit.field === 'recent' ? updatedAt : hit.score,
    };
}

function externalEntry(hit: IndexedConversationHit): RankedEntry {
    return {
        entry: {
            key: hit.key,
            title: bounded(hit.title ?? ''),
            status: 'external',
            provider: hit.provider,
            agentSessionId: hit.agentSessionId,
            ...(hit.cwd !== undefined && { cwd: hit.cwd }),
            updatedAt: Math.trunc(hit.updatedAt),
            match: matchOf(hit),
        },
        score: hit.score,
    };
}

function sessionEntry(
    session: SessionRecord,
    conversation: HeldConversation | undefined,
    field: SessionSearchEntry['match']['field'],
    updatedAt: number,
): SessionSearchEntry {
    return {
        key: conversation
            ? conversationKey(conversation.provider, conversation.agentSessionId)
            : `session:${session.id}`,
        title: bounded(session.displayTitle),
        status: sessionStatus(session),
        sessionId: session.id,
        projectId: session.projectId,
        ...(conversation && {
            provider: conversation.provider,
            agentSessionId: conversation.agentSessionId,
        }),
        cwd: session.rootPath,
        updatedAt,
        match: { field },
    };
}
