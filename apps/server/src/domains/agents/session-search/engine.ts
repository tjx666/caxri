import type {
    AgentProvider,
    SessionSearchMatchField,
    SessionSearchPreviewParameters,
    SessionSearchPreviewResult,
    SessionSearchRelaxation,
    SessionSearchSnippet,
} from '@caxri/protocol';
import { SESSION_SEARCH_PREVIEW_CONTEXT_MESSAGES } from '@caxri/protocol';

import type { AgentEnvironment } from '../contract';
import type { ContentHit, Conversation } from './conversations';
import {
    compareHits,
    foldContentHit,
    groupConversations,
    isWithinRoot,
    recencyBoost,
} from './conversations';
import type { IndexerPassReport } from './indexer';
import { SessionSearchIndexer } from './indexer';
import {
    metadataMatch,
    parseSessionQuery,
    previewMessage,
    snippetAround,
    snippetFromMarkers,
    withTermHighlights,
} from './query';
import type { SessionSearchStore } from './store';

export { compareHits, conversationKey } from './conversations';

/**
 * A provider's history changes while Caxri runs; a search started this long after the previous pass starts another in
 * the background and answers from the index as it stands.
 */
const REFRESH_INTERVAL_MS = 30_000;
/**
 * A forced pass for a newly held hosted conversation waits at least this long after the previous forced one, so a
 * conversation that cannot be indexed does not start a pass on every keystroke.
 */
const FORCED_REFRESH_INTERVAL_MS = 5_000;
export interface IndexSearchRequest {
    query: string;
    providers?: AgentProvider[];
    /**
     * Keeps (`include`) or drops (`exclude`) conversations by `<provider>:<conversation id>` key, so the Server can
     * filter by where a conversation lives before the result limit applies.
     */
    restrict?: { mode: 'exclude' | 'include'; keys: string[] };
    /**
     * `<provider>:<conversation id>` keys of the conversations Caxri Sessions hold. A hosted conversation (one an
     * application started through the Agent SDK) appears only when listed here, so an Agent Chat conversation written
     * before Caxri labelled its own is searchable while a Session holds it, and another application's SDK runs stay
     * out.
     */
    heldKeys?: string[];
    /**
     * Keeps conversations whose folder contains one of these lower-cased strings (`project:` operators).
     */
    projects?: string[];
    /**
     * Keeps conversations last updated before this time, in epoch milliseconds (`before:`).
     */
    beforeMs?: number;
    /**
     * Keeps conversations last updated at or after this time, in epoch milliseconds (`after:`).
     */
    afterMs?: number;
    /**
     * Root of the Project the user is working in. A ranking hint: conversations that ran inside it sort ahead of every
     * other, and none is dropped.
     */
    preferredRoot?: string;
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
     * A message holds the whole query as one phrase, spacing aside; such a hit outranks others on the same field.
     */
    isPhraseMatch?: boolean;
    /**
     * The conversation ran inside the request's `preferredRoot`.
     */
    isCurrentProject?: boolean;
    /**
     * Orders hits that matched on the same field and phrase; higher is better.
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
    /**
     * How far the query was loosened to produce `hits`; `phrase` when it was not.
     */
    relaxation: SessionSearchRelaxation;
}

/**
 * Answers Session search queries from the persistent index and keeps it fresh. Runs inside the search Worker, so a slow
 * pass or a substring scan never blocks Server Core.
 */
export class SessionSearchEngine {
    private lastRefreshAt = -Infinity;

    private lastForcedRefreshAt = -Infinity;

    /**
     * `<provider>:<conversation id>` keys Sessions held at the latest search; the indexer reads a hosted conversation's
     * body only for these.
     */
    private heldKeys: ReadonlySet<string> = new Set();

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
     * scan with no ranking, the newest) and the newest message holding the whole query as a phrase.
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
        if (parsed.phrase === undefined || merged.size === 0) return merged;
        for (const row of this.store.phraseMatches(
            parsed.ftsQuery,
            parsed.substrings,
            parsed.phrase,
            providers,
        )) {
            const match = merged.get(keyByTranscript.get(row.transcript) ?? '');
            if (match && row.messageId > (match.phraseMessageId ?? -Infinity))
                match.phraseMessageId = row.messageId;
        }
        return merged;
    }

    private snippet(
        parsed: ReturnType<typeof parseSessionQuery>,
        messageId: number,
        isPhraseMatch: boolean,
    ): SessionSearchSnippet | undefined {
        if (!isPhraseMatch && parsed.ftsQuery) {
            const row = this.store.snippet(parsed.ftsQuery, messageId);
            return (
                row &&
                withTermHighlights(
                    snippetFromMarkers(row.role === 'user' ? 'user' : 'assistant', row.snippet),
                    parsed.substrings,
                )
            );
        }
        // FTS5 centers its excerpt on the indexed terms alone, which may sit far from the phrase.
        const message = this.store.message(messageId);
        return (
            message &&
            snippetAround(
                message.role,
                message.text,
                parsed.terms,
                isPhraseMatch ? parsed.phrase : undefined,
            )
        );
    }

    /**
     * Conversations that pass the request's access and filter rules: a hosted one only while a Session holds it, the
     * `restrict` set, `project:` folders, and the `before:`/`after:` window.
     */
    private isAllowed(
        request: IndexSearchRequest,
        held: ReadonlySet<string>,
        restricted: ReadonlySet<string> | undefined,
        conversation: Conversation,
    ): boolean {
        if (conversation.isHosted && !held.has(conversation.key)) return false;
        if (request.restrict) {
            const isListed = restricted?.has(conversation.key) ?? false;
            if (isListed !== (request.restrict.mode === 'include')) return false;
        }
        // A held conversation is shown as its Session, dated by the Session's activity, which the caller filters.
        const isDated = !held.has(conversation.key);
        if (isDated && request.beforeMs !== undefined && conversation.updatedAt >= request.beforeMs)
            return false;
        if (isDated && request.afterMs !== undefined && conversation.updatedAt < request.afterMs)
            return false;
        if (request.projects?.length) {
            const cwd = conversation.cwd?.toLowerCase() ?? '';
            if (request.projects.every((project) => !cwd.includes(project))) return false;
        }
        return true;
    }

    /**
     * Ranks the conversations matching the query's words: every word (`all`) or at least one (`any`).
     */
    private rank(
        mode: 'all' | 'any',
        parsed: ReturnType<typeof parseSessionQuery>,
        request: IndexSearchRequest,
        scope: {
            conversations: ReadonlyMap<string, Conversation>;
            keyByTranscript: ReadonlyMap<number, string>;
            isAllowed: (conversation: Conversation) => boolean;
        },
    ): { hits: IndexedConversationHit[]; bestMessages: Map<string, number> } {
        const { conversations, keyByTranscript, isAllowed } = scope;
        const hits = new Map<string, IndexedConversationHit>();
        for (const conversation of conversations.values()) {
            if (!isAllowed(conversation)) continue;
            const field = metadataMatch(
                parsed.terms,
                {
                    ...(conversation.title !== undefined && { title: conversation.title }),
                    ...(conversation.cwd !== undefined && { cwd: conversation.cwd }),
                    ids: [conversation.agentSessionId],
                },
                mode,
            );
            if (field)
                hits.set(conversation.key, this.hit(conversation, field, conversation.updatedAt));
        }
        const content =
            mode === 'all'
                ? this.contentHits(parsed, request.providers, keyByTranscript)
                : this.anyWordContentHits(parsed, request.providers, keyByTranscript);
        const bestMessages = new Map<string, number>();
        for (const [key, match] of content) {
            const conversation = conversations.get(key);
            if (!conversation || !isAllowed(conversation)) continue;
            bestMessages.set(key, match.phraseMessageId ?? match.bestMessageId);
            const isPhraseMatch = match.phraseMessageId !== undefined;
            const existing = hits.get(key);
            if (existing) {
                existing.messageCount = match.hits;
                if (isPhraseMatch) existing.isPhraseMatch = true;
                continue;
            }
            const score =
                match.rank === undefined
                    ? conversation.updatedAt
                    : -match.rank * recencyBoost(conversation.updatedAt, this.now());
            hits.set(key, {
                ...this.hit(conversation, 'content', score),
                messageCount: match.hits,
                ...(isPhraseMatch && { isPhraseMatch }),
            });
        }
        return { hits: hits.values().toArray(), bestMessages };
    }

    /**
     * Messages holding at least one of the words: each word is searched alone and the per-conversation results are
     * merged, because FTS5 cannot OR a full-text match with a substring pattern.
     */
    private anyWordContentHits(
        parsed: ReturnType<typeof parseSessionQuery>,
        providers: readonly AgentProvider[] | undefined,
        keyByTranscript: ReadonlyMap<number, string>,
    ): Map<string, ContentHit> {
        const merged = new Map<string, ContentHit>();
        for (const term of parsed.terms) {
            const single = { ...parseSessionQuery(term), phrase: undefined };
            for (const [key, match] of this.contentHits(single, providers, keyByTranscript)) {
                const existing = merged.get(key);
                if (existing) foldContentHit(existing, match);
                else merged.set(key, match);
            }
        }
        return merged;
    }

    private async refreshInBackground(): Promise<void> {
        let report: IndexerPassReport;
        try {
            report = await this.indexer.refresh(this.heldKeys);
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
     * Starts a pass now (at most every few seconds) so a hosted conversation a Session just took over becomes
     * searchable without waiting for the regular interval.
     */
    private refreshForHeldBodies(): void {
        if (this.indexer.progress().isRunning) return;
        if (this.now() - this.lastForcedRefreshAt < FORCED_REFRESH_INTERVAL_MS) return;
        this.lastForcedRefreshAt = this.now();
        this.lastRefreshAt = this.now();
        void this.refreshInBackground();
    }

    /**
     * Starts a background pass unless one ran recently; the current search does not wait for it.
     */
    refreshIfStale(): void {
        if (this.indexer.progress().isRunning) return;
        if (this.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
        this.lastRefreshAt = this.now();
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
        const held = new Set(request.heldKeys);
        this.heldKeys = held;
        this.refreshIfStale();
        const { conversations, keyByTranscript } = groupConversations(
            this.store.conversations(request.providers),
        );
        // A Session took over a hosted conversation whose body was skipped: read it now instead of at the next interval.
        if (conversations.values().some((item) => item.isBodiless && held.has(item.key)))
            this.refreshForHeldBodies();
        const { preferredRoot } = request;
        // Built once per search: isAllowed runs for every stored conversation and every content hit.
        const restricted = request.restrict ? new Set(request.restrict.keys) : undefined;
        const isAllowed = (conversation: Conversation) =>
            this.isAllowed(request, held, restricted, conversation);
        const finish = (hits: IndexedConversationHit[]) =>
            hits
                .map((hit) =>
                    preferredRoot !== undefined && isWithinRoot(hit.cwd, preferredRoot)
                        ? { ...hit, isCurrentProject: true }
                        : hit,
                )
                .toSorted(compareHits)
                .slice(0, request.limit);
        const parsed = parseSessionQuery(request.query);
        const status = this.status();
        if (parsed.terms.length === 0) {
            const hits = conversations
                .values()
                .filter((conversation) => isAllowed(conversation))
                .toArray()
                .toSorted((left, right) => right.updatedAt - left.updatedAt)
                .map((conversation) => this.hit(conversation, 'recent', conversation.updatedAt));
            return {
                hits: finish(hits),
                status,
                usedSubstringScan: false,
                relaxation: 'phrase',
            };
        }
        const scope = { conversations, keyByTranscript, isAllowed };
        let relaxation: SessionSearchRelaxation = 'phrase';
        let result = this.rank('all', parsed, request, scope);
        if (parsed.terms.length > 1) {
            if (result.hits.length === 0) {
                // Nothing holds every word: fall back to conversations holding at least one.
                const loosened = this.rank('any', parsed, request, scope);
                if (loosened.hits.length > 0) {
                    result = loosened;
                    relaxation = 'anyWord';
                }
            } else if (result.hits.every((hit) => !hit.isPhraseMatch)) relaxation = 'allWords';
        }
        // The any-word step has no phrase and no full-text query that matches all words, so quote nothing around it.
        const snippetQuery =
            relaxation === 'anyWord'
                ? { ...parsed, ftsQuery: undefined, phrase: undefined }
                : parsed;
        const ranked = finish(result.hits);
        for (const hit of ranked) {
            const messageId = result.bestMessages.get(hit.key);
            if (messageId === undefined) continue;
            const snippet = this.snippet(snippetQuery, messageId, hit.isPhraseMatch ?? false);
            if (snippet) hit.snippet = snippet;
        }
        return {
            hits: ranked,
            status,
            usedSubstringScan: parsed.substrings.length > 0,
            relaxation,
        };
    }

    /**
     * A bounded window of one conversation's indexed messages: the `matchIndex`-th (default newest) message holding
     * every query term with two messages on each side, or the conversation's last messages when nothing matches. Reads
     * the index only.
     */
    preview(request: SessionSearchPreviewParameters): SessionSearchPreviewResult {
        const { provider, agentSessionId } = request;
        const { terms } = parseSessionQuery(request.query);
        const ids = this.store.conversationMessageIds(provider, agentSessionId);
        const matches =
            terms.length > 0 ? this.store.matchingMessageIds(provider, agentSessionId, terms) : [];
        const matchIndex =
            matches.length > 0 ? (request.matchIndex ?? matches.length - 1) % matches.length : 0;
        const centerId = matches.length > 0 ? matches[matchIndex] : ids.at(-1);
        const center = centerId === undefined ? -1 : ids.indexOf(centerId);
        if (center === -1)
            return {
                messages: [],
                matchCount: 0,
                matchIndex: 0,
                hasEarlier: false,
                hasLater: false,
            };
        const span = SESSION_SEARCH_PREVIEW_CONTEXT_MESSAGES;
        // Without a match the window is the conversation's last messages rather than centered on one.
        const first = Math.max(0, matches.length > 0 ? center - span : ids.length - (2 * span + 1));
        const last = Math.min(ids.length, first + 2 * span + 1);
        const messages = ids.slice(first, last).flatMap((id) => {
            const message = this.store.message(id);
            return message
                ? [
                      previewMessage(
                          message.role,
                          message.text,
                          terms,
                          matches.length > 0 && id === centerId,
                      ),
                  ]
                : [];
        });
        return {
            messages,
            matchCount: matches.length,
            matchIndex,
            hasEarlier: first > 0,
            hasLater: last < ids.length,
        };
    }
}
