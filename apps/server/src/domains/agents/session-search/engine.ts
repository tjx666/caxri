import type { AgentProvider, SessionSearchMatchField, SessionSearchSnippet } from '@caxri/protocol';

import type { AgentEnvironment } from '../contract';
import type { IndexerPassReport } from './indexer';
import { SessionSearchIndexer } from './indexer';
import { metadataMatch, parseSessionQuery, snippetAround, snippetFromMarkers } from './query';
import type { SessionSearchStore, StoredTranscript } from './store';

/**
 * A provider's history changes while Caxri runs; a search started this long after the previous pass starts another in
 * the background and answers from the index as it stands.
 */
const REFRESH_INTERVAL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Bm25 relevance is boosted up to twice for a conversation updated today, halving the boost by about a month old.
 */
const RECENCY_HALF_LIFE_DAYS = 30;

export interface IndexSearchRequest {
    query: string;
    providers?: AgentProvider[];
    /**
     * Keeps (`include`) or drops (`exclude`) conversations by `<provider>:<conversation id>` key, so the Server can
     * filter by where a conversation lives before the result limit applies.
     */
    restrict?: { mode: 'exclude' | 'include'; keys: string[] };
    limit: number;
}

export interface IndexedConversationHit {
    key: string;
    provider: AgentProvider;
    agentSessionId: string;
    title?: string;
    cwd?: string;
    updatedAt: number;
    field: SessionSearchMatchField;
    snippet?: SessionSearchSnippet;
    messageCount?: number;
    /**
     * Orders hits that matched on the same field; higher is better.
     */
    score: number;
}

export interface IndexStatus {
    state: 'indexing' | 'ready';
    conversations: number;
    pending: number;
}

export interface IndexSearchResponse {
    hits: IndexedConversationHit[];
    status: IndexStatus;
    usedSubstringScan: boolean;
}

interface Conversation {
    key: string;
    provider: AgentProvider;
    agentSessionId: string;
    title?: string;
    cwd?: string;
    updatedAt: number;
    hasMain: boolean;
}

interface ContentHit {
    hits: number;
    rank?: number;
    bestMessageId: number;
}

export function conversationKey(provider: string, agentSessionId: string): string {
    return `${provider}:${agentSessionId}`;
}

/**
 * Ranks an ID match above a title match above a folder match above a message match, as session browsers do: the
 * conversation someone names is the one they want, however often a phrase recurs elsewhere.
 */
const matchFieldOrder: Record<SessionSearchMatchField, number> = {
    id: 0,
    title: 1,
    path: 2,
    content: 3,
    recent: 4,
};

export function compareHits(
    left: { field: SessionSearchMatchField; score: number },
    right: { field: SessionSearchMatchField; score: number },
): number {
    return matchFieldOrder[left.field] - matchFieldOrder[right.field] || right.score - left.score;
}

/**
 * One conversation per provider and conversation ID. A reverted Codex thread's continuation file shares its ID; the
 * original file names the conversation, and the newest file dates it.
 */
function groupConversations(rows: readonly StoredTranscript[]) {
    const conversations = new Map<string, Conversation>();
    const keyByTranscript = new Map<number, string>();
    for (const row of rows) {
        const key = conversationKey(row.provider, row.agentSessionId);
        keyByTranscript.set(row.id, key);
        const existing = conversations.get(key);
        if (!existing) {
            conversations.set(key, {
                key,
                provider: row.provider,
                agentSessionId: row.agentSessionId,
                ...(row.title !== undefined && { title: row.title }),
                ...(row.cwd !== undefined && { cwd: row.cwd }),
                updatedAt: row.mtimeMs,
                hasMain: !row.isContinuation,
            });
            continue;
        }
        existing.updatedAt = Math.max(existing.updatedAt, row.mtimeMs);
        if (!row.isContinuation && !existing.hasMain) {
            existing.hasMain = true;
            if (row.title !== undefined) existing.title = row.title;
            if (row.cwd !== undefined) existing.cwd = row.cwd;
        }
        existing.title ??= row.title;
        existing.cwd ??= row.cwd;
    }
    return { conversations, keyByTranscript };
}

function recencyBoost(updatedAt: number, now: number): number {
    const ageDays = Math.max(0, now - updatedAt) / DAY_MS;
    return 1 + 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Answers Session search queries from the persistent index and keeps it fresh. Runs inside the search Worker, so a slow
 * pass or a substring scan never blocks Server Core.
 */
export class SessionSearchEngine {
    private lastRefreshAt = -Infinity;

    readonly indexer: SessionSearchIndexer;

    constructor(
        private readonly store: SessionSearchStore,
        environment: AgentEnvironment,
        private readonly options: {
            now?: () => number;
            onPass?: (report: IndexerPassReport) => void;
            onPassFailed?: () => void;
        } = {},
    ) {
        this.indexer = new SessionSearchIndexer(store, environment, () => this.now());
    }

    private hit(
        conversation: Conversation,
        field: SessionSearchMatchField,
        score: number,
    ): IndexedConversationHit {
        return {
            key: conversation.key,
            provider: conversation.provider,
            agentSessionId: conversation.agentSessionId,
            ...(conversation.title !== undefined && { title: conversation.title }),
            ...(conversation.cwd !== undefined && { cwd: conversation.cwd }),
            updatedAt: conversation.updatedAt,
            field,
            score,
        };
    }

    /**
     * Folds per-transcript matches into per-conversation ones, keeping the best-ranked message (or, for a substring
     * scan with no ranking, the newest).
     */
    private contentHits(
        parsed: ReturnType<typeof parseSessionQuery>,
        providers: readonly AgentProvider[] | undefined,
        keyByTranscript: ReadonlyMap<number, string>,
    ): Map<string, ContentHit> {
        const merged = new Map<string, ContentHit>();
        for (const row of this.store.contentMatches(
            parsed.ftsQuery,
            parsed.substrings,
            providers,
        )) {
            const key = keyByTranscript.get(row.transcript);
            if (!key) continue;
            const existing = merged.get(key);
            if (!existing) {
                merged.set(key, {
                    hits: row.hits,
                    ...(row.rank !== undefined && { rank: row.rank }),
                    bestMessageId: row.bestMessageId,
                });
                continue;
            }
            existing.hits += row.hits;
            const isBetter =
                row.rank === undefined || existing.rank === undefined
                    ? row.bestMessageId > existing.bestMessageId
                    : row.rank < existing.rank;
            if (isBetter) {
                existing.bestMessageId = row.bestMessageId;
                if (row.rank !== undefined) existing.rank = row.rank;
            }
        }
        return merged;
    }

    private snippet(
        parsed: ReturnType<typeof parseSessionQuery>,
        messageId: number,
    ): SessionSearchSnippet | undefined {
        if (parsed.ftsQuery) {
            const row = this.store.snippet(parsed.ftsQuery, messageId);
            return (
                row && snippetFromMarkers(row.role === 'user' ? 'user' : 'assistant', row.snippet)
            );
        }
        const message = this.store.message(messageId);
        return message && snippetAround(message.role, message.text, parsed.substrings);
    }

    private async refreshInBackground(): Promise<void> {
        let report: IndexerPassReport;
        try {
            report = await this.indexer.refresh();
        } catch {
            this.options.onPassFailed?.();
            return;
        }
        this.options.onPass?.(report);
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    /**
     * Starts a background pass unless one ran recently; the current search does not wait for it.
     */
    refreshIfStale(): void {
        if (this.indexer.progress().isRunning) return;
        if (this.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
        this.lastRefreshAt = this.now();
        // eslint-disable-next-line no-void -- a background pass reports through the callbacks, never to the search
        void this.refreshInBackground();
    }

    status(): IndexStatus {
        const progress = this.indexer.progress();
        const { conversations } = groupConversations(this.store.conversations());
        return {
            state: progress.isRunning ? 'indexing' : 'ready',
            conversations: conversations.size,
            pending: progress.pending,
        };
    }

    search(request: IndexSearchRequest): IndexSearchResponse {
        this.refreshIfStale();
        const { conversations, keyByTranscript } = groupConversations(
            this.store.conversations(request.providers),
        );
        const restricted = request.restrict && new Set(request.restrict.keys);
        const isAllowed = (key: string) =>
            !restricted || restricted.has(key) === (request.restrict?.mode === 'include');
        const parsed = parseSessionQuery(request.query);
        const status = this.status();
        if (parsed.terms.length === 0) {
            const hits = conversations
                .values()
                .filter((conversation) => isAllowed(conversation.key))
                .toArray()
                .toSorted((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, request.limit)
                .map((conversation) => this.hit(conversation, 'recent', conversation.updatedAt));
            return { hits, status, usedSubstringScan: false };
        }
        const hits = new Map<string, IndexedConversationHit>();
        for (const conversation of conversations.values()) {
            if (!isAllowed(conversation.key)) continue;
            const field = metadataMatch(parsed.terms, {
                ...(conversation.title !== undefined && { title: conversation.title }),
                ...(conversation.cwd !== undefined && { cwd: conversation.cwd }),
                ids: [conversation.agentSessionId],
            });
            if (field)
                hits.set(conversation.key, this.hit(conversation, field, conversation.updatedAt));
        }
        const content = this.contentHits(parsed, request.providers, keyByTranscript);
        const bestMessages = new Map<string, number>();
        for (const [key, match] of content) {
            const conversation = conversations.get(key);
            if (!conversation || !isAllowed(key)) continue;
            bestMessages.set(key, match.bestMessageId);
            const existing = hits.get(key);
            if (existing) {
                existing.messageCount = match.hits;
                continue;
            }
            const score =
                match.rank === undefined
                    ? conversation.updatedAt
                    : -match.rank * recencyBoost(conversation.updatedAt, this.now());
            hits.set(key, {
                ...this.hit(conversation, 'content', score),
                messageCount: match.hits,
            });
        }
        const ranked = hits.values().toArray().toSorted(compareHits).slice(0, request.limit);
        for (const hit of ranked) {
            const messageId = bestMessages.get(hit.key);
            if (messageId === undefined) continue;
            const snippet = this.snippet(parsed, messageId);
            if (snippet) hit.snippet = snippet;
        }
        return { hits: ranked, status, usedSubstringScan: parsed.substrings.length > 0 };
    }
}
