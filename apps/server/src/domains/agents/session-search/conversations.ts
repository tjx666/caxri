import { sep } from 'node:path';

import type { AgentProvider, SessionSearchMatchField } from '@caxri/protocol';

import type { StoredTranscript } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Bm25 relevance is boosted up to twice for a conversation updated today, halving the boost by about a month old.
 */
const RECENCY_HALF_LIFE_DAYS = 30;

export interface Conversation {
    key: string;
    provider: AgentProvider;
    agentSessionId: string;
    title?: string;
    cwd?: string;
    updatedAt: number;
    hasMain: boolean;
    isHosted: boolean;
    /**
     * A hosted conversation whose body was never indexed because no Session held it then.
     */
    isBodiless: boolean;
    /**
     * Key of the conversation this one was forked from, when its transcript names one.
     */
    forkedFromKey?: string;
}

export interface ContentHit {
    hits: number;
    rank?: number;
    bestMessageId: number;
    /**
     * The newest message holding the whole query as one phrase, which the snippet quotes instead of the best-ranked
     * one.
     */
    phraseMessageId?: number;
}

/**
 * A hosted transcript the indexer stored without reading it. A body that was read has a scan cursor past zero (an empty
 * file has none, but also nothing to read).
 */
function isBodiless(row: StoredTranscript): boolean {
    return row.state === 'hosted' && row.scanOffset === 0 && row.size > 0;
}

export function isWithinRoot(path: string | undefined, root: string): boolean {
    return path !== undefined && (path === root || path.startsWith(`${root}${sep}`));
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

interface Rankable {
    field: SessionSearchMatchField;
    isCurrentProject?: boolean;
    isPhraseMatch?: boolean;
    score: number;
}

export function compareHits(left: Rankable, right: Rankable): number {
    return (
        Number(right.isCurrentProject ?? false) - Number(left.isCurrentProject ?? false) ||
        matchFieldOrder[left.field] - matchFieldOrder[right.field] ||
        Number(right.isPhraseMatch ?? false) - Number(left.isPhraseMatch ?? false) ||
        right.score - left.score
    );
}

/**
 * One conversation per provider and conversation ID. A reverted Codex thread's continuation file shares its ID; the
 * original file names the conversation, and the newest file dates it.
 */
export function groupConversations(rows: readonly StoredTranscript[]) {
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
                isHosted: row.state === 'hosted',
                isBodiless: isBodiless(row),
                ...(row.forkedFromId !== undefined && {
                    forkedFromKey: conversationKey(row.provider, row.forkedFromId),
                }),
            });
            continue;
        }
        existing.updatedAt = Math.max(existing.updatedAt, row.mtimeMs);
        existing.isHosted ||= row.state === 'hosted';
        existing.isBodiless &&= isBodiless(row);
        if (!row.isContinuation && !existing.hasMain) {
            existing.hasMain = true;
            if (row.title !== undefined) existing.title = row.title;
            if (row.cwd !== undefined) existing.cwd = row.cwd;
            if (row.forkedFromId !== undefined)
                existing.forkedFromKey = conversationKey(row.provider, row.forkedFromId);
        }
        existing.title ??= row.title;
        existing.cwd ??= row.cwd;
    }
    return { conversations, keyByTranscript };
}

/**
 * The key of each conversation's fork tree: the oldest ancestor its transcripts name, which may itself be missing from
 * the index (a deleted or excluded original still ties its surviving branches together). A conversation outside any
 * fork maps to its own key. Fork cycles, which no provider writes, stop at the first repeated key.
 */
export function forkRoots(conversations: ReadonlyMap<string, Conversation>): Map<string, string> {
    return new Map(conversations.keys().map((key) => [key, oldestAncestor(conversations, key)]));
}

function oldestAncestor(conversations: ReadonlyMap<string, Conversation>, start: string): string {
    const seen = new Set([start]);
    let current = start;
    for (
        let parent = conversations.get(current)?.forkedFromKey;
        parent !== undefined && !seen.has(parent);
        parent = conversations.get(current)?.forkedFromKey
    ) {
        seen.add(parent);
        current = parent;
    }
    return current;
}

/**
 * Adds another match of the same conversation to `existing`, keeping the best-ranked message (or the newest, without
 * ranking).
 */
export function foldContentHit(existing: ContentHit, match: ContentHit): void {
    existing.hits += match.hits;
    const isBetter =
        match.rank === undefined || existing.rank === undefined
            ? match.bestMessageId > existing.bestMessageId
            : match.rank < existing.rank;
    if (!isBetter) return;
    existing.bestMessageId = match.bestMessageId;
    if (match.rank !== undefined) existing.rank = match.rank;
}

export function recencyBoost(updatedAt: number, now: number): number {
    const ageDays = Math.max(0, now - updatedAt) / DAY_MS;
    return 1 + 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS);
}
