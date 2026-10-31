import type {
    AgentProvider,
    SessionRecord,
    SessionSearchEntry,
    SessionSearchFilters,
    SessionSearchStatus,
} from '@caxri/protocol';

import type { IndexedConversationHit } from '../agents';
import { compareHits, conversationKey } from '../agents';

const MAX_TITLE_LENGTH = 1_024;

export interface HeldConversation {
    session: SessionRecord;
    provider: AgentProvider;
    agentSessionId: string;
}

export interface Holdings {
    /**
     * Provider conversations a visible Session holds, by `<provider>:<conversation id>`.
     */
    byKey: Map<string, HeldConversation>;
    /**
     * Each visible Session's conversations, its current Primary Agent binding first.
     */
    bySession: Map<string, HeldConversation[]>;
    /**
     * Conversations held by a Session in a hidden Project (such as Caxri Bot's): never offered as external.
     */
    hiddenKeys: Set<string>;
}

/**
 * What the query's operators and the caller's hint ask of one search, resolved once.
 */
export interface SearchScope {
    /**
     * The query without its operators.
     */
    text: string;
    filters: SessionSearchFilters;
    /**
     * The Agent providers to search: the `providers` parameter narrowed by `agent:` operators; empty means none match.
     */
    providers: AgentProvider[] | undefined;
    beforeMs?: number;
    afterMs?: number;
    /**
     * The Project the user is working in, when the caller named a known one.
     */
    current?: { id: string; rootPath: string };
    /**
     * The only Projects a scoped caller (a paired device) may see. Set, it keeps Sessions inside them and drops every
     * external conversation, since no grant covers one.
     */
    projects?: ReadonlySet<string>;
}

/**
 * Treats a Session outside a scoped caller's Projects like one in a hidden Project: its conversations are neither
 * listed as that Session nor offered as external.
 */
export function scopedHoldings(holdings: Holdings, projects: ReadonlySet<string>): Holdings {
    const scoped: Holdings = {
        byKey: new Map(),
        bySession: new Map(),
        hiddenKeys: new Set(holdings.hiddenKeys),
    };
    for (const [key, held] of holdings.byKey)
        if (projects.has(held.session.projectId)) scoped.byKey.set(key, held);
        else scoped.hiddenKeys.add(key);
    for (const [sessionId, list] of holdings.bySession)
        if (projects.has(list[0].session.projectId)) scoped.bySession.set(sessionId, list);
    return scoped;
}

export interface RankedEntry {
    entry: SessionSearchEntry;
    isCurrentProject?: boolean;
    isPhraseMatch?: boolean;
    /**
     * The fork tree the conversation belongs to, from the index; entries sharing it are branches of one conversation.
     */
    forkGroup?: string;
    score: number;
}

export function sessionStatus(session: SessionRecord): SessionSearchStatus {
    return session.archivedAt === undefined ? 'open' : 'archived';
}

function bounded(title: string): string {
    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}

export function compareRanked(left: RankedEntry, right: RankedEntry): number {
    return compareHits(
        {
            field: left.entry.match.field,
            isCurrentProject: left.isCurrentProject,
            isPhraseMatch: left.isPhraseMatch,
            score: left.score,
        },
        {
            field: right.entry.match.field,
            isCurrentProject: right.isCurrentProject,
            isPhraseMatch: right.isPhraseMatch,
            score: right.score,
        },
    );
}

function matchOf(hit: IndexedConversationHit): SessionSearchEntry['match'] {
    return {
        field: hit.field,
        ...(hit.snippet && { snippet: hit.snippet }),
        ...(hit.messageCount !== undefined && { messageCount: hit.messageCount }),
    };
}

export function heldEntry(
    held: HeldConversation,
    hit: IndexedConversationHit,
    scope: SearchScope,
): RankedEntry {
    const updatedAt = Math.trunc(Math.max(hit.updatedAt, held.session.sessionActivityAt));
    return {
        entry: {
            ...sessionEntry(held.session, held, hit.field, updatedAt),
            ...(hit.cwd !== undefined && { cwd: hit.cwd }),
            ...(hit.totalMessages !== undefined && { totalMessages: hit.totalMessages }),
            match: matchOf(hit),
        },
        ...(hit.isPhraseMatch && { isPhraseMatch: true }),
        ...(hit.forkGroup !== undefined && { forkGroup: hit.forkGroup }),
        ...(scope.current?.id === held.session.projectId && { isCurrentProject: true }),
        score: hit.field === 'recent' ? updatedAt : hit.score,
    };
}

export function externalEntry(hit: IndexedConversationHit, scope: SearchScope): RankedEntry {
    return {
        entry: {
            key: hit.key,
            title: bounded(hit.title ?? ''),
            status: 'external',
            provider: hit.provider,
            agentSessionId: hit.agentSessionId,
            ...(hit.cwd !== undefined && { cwd: hit.cwd }),
            updatedAt: Math.trunc(hit.updatedAt),
            ...(hit.totalMessages !== undefined && { totalMessages: hit.totalMessages }),
            match: matchOf(hit),
        },
        ...(hit.isPhraseMatch && { isPhraseMatch: true }),
        ...(hit.forkGroup !== undefined && { forkGroup: hit.forkGroup }),
        ...(scope.current && hit.isCurrentProject && { isCurrentProject: true }),
        score: hit.score,
    };
}

export function sessionEntry(
    session: SessionRecord,
    conversation: HeldConversation | undefined,
    field: SessionSearchEntry['match']['field'],
    updatedAt: number,
): SessionSearchEntry {
    return {
        key: conversation
            ? conversationKey(conversation.provider, conversation.agentSessionId)
            : `session:${session.id}`,
        title: bounded(session.title),
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
