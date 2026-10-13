import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    agentChatDraftsStorageKey,
    MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS,
    MAX_PERSISTED_AGENT_CHAT_DRAFTS,
    parsePersistedAgentChatDrafts,
    persistableAgentChatDrafts,
} from '../agent-chat-drafts';

/**
 * The suite runs under Vitest's `node` environment, so each test installs a `window`, `document`, and `localStorage`
 * and loads a fresh copy of the module, the way a restarted Renderer starts from storage alone.
 */
function stubRenderer(entries: Map<string, string>) {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    });
    vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' });
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
    });
    return listeners;
}

async function loadDrafts() {
    vi.resetModules();
    return import('../agent-chat-drafts');
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Agent Chat draft persistence', () => {
    it('restores a draft after the Renderer restarts, and forgets one cleared by a send', async () => {
        vi.useFakeTimers();
        const storage = new Map<string, string>();
        stubRenderer(storage);
        const first = await loadDrafts();
        first.writeAgentChatDraft('chat-a', 'half written');
        first.writeAgentChatDraft('chat-b', 'other');
        // Nothing is written while the user is still typing.
        expect(storage.has(agentChatDraftsStorageKey('local'))).toBe(false);
        vi.advanceTimersByTime(300);

        const restarted = await loadDrafts();
        expect(restarted.readAgentChatDraft('chat-a')).toBe('half written');
        expect(restarted.readAgentChatDraft('chat-b')).toBe('other');

        restarted.writeAgentChatDraft('chat-a', '');
        vi.advanceTimersByTime(300);
        const again = await loadDrafts();
        expect(again.readAgentChatDraft('chat-a')).toBe('');
        expect(again.readAgentChatDraft('chat-b')).toBe('other');
    });

    it('writes pending keystrokes as soon as the window goes away', async () => {
        vi.useFakeTimers();
        const storage = new Map<string, string>();
        const listeners = stubRenderer(storage);
        const drafts = await loadDrafts();
        drafts.writeAgentChatDraft('chat-a', 'typed right before quitting');
        const pagehide = listeners.get('pagehide');
        expect(pagehide).toBeDefined();
        pagehide?.();
        const stored = storage.get(agentChatDraftsStorageKey('local'));
        expect(JSON.parse(stored ?? 'null')).toEqual([['chat-a', 'typed right before quitting']]);
    });

    it('keeps the drafts two windows of one scope save for different Chats', async () => {
        vi.useFakeTimers();
        const storage = new Map<string, string>();
        stubRenderer(storage);
        // Two Renderers over one `localStorage`, each having read it before the other wrote.
        const first = await loadDrafts();
        first.readAgentChatDraft('chat-a');
        const second = await loadDrafts();
        second.readAgentChatDraft('chat-b');

        first.writeAgentChatDraft('chat-a', 'typed in the first window');
        second.writeAgentChatDraft('chat-b', 'typed in the second window');
        vi.advanceTimersByTime(300);

        const restarted = await loadDrafts();
        expect(restarted.readAgentChatDraft('chat-a')).toBe('typed in the first window');
        expect(restarted.readAgentChatDraft('chat-b')).toBe('typed in the second window');
    });

    it('ignores a malformed entry instead of failing', () => {
        expect(parsePersistedAgentChatDrafts(undefined).size).toBe(0);
        expect(parsePersistedAgentChatDrafts({ 'chat-a': 'text' }).size).toBe(0);
        expect([
            ...parsePersistedAgentChatDrafts([
                ['chat-a', 'kept'],
                ['chat-b', 3],
                ['', 'no id'],
                ['chat-c', ''],
                'loose',
            ]),
        ]).toEqual([['chat-a', 'kept']]);
    });

    it('keeps only the most recent drafts within the count and size bounds', () => {
        const many = new Map(
            Array.from({ length: MAX_PERSISTED_AGENT_CHAT_DRAFTS + 5 }, (_, index) => [
                `chat-${index}`,
                'x',
            ]),
        );
        const kept = persistableAgentChatDrafts(many);
        expect(kept).toHaveLength(MAX_PERSISTED_AGENT_CHAT_DRAFTS);
        expect(kept[0]?.[0]).toBe('chat-5');
        expect(kept.at(-1)?.[0]).toBe(`chat-${MAX_PERSISTED_AGENT_CHAT_DRAFTS + 4}`);

        const half = 'y'.repeat(MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS / 2);
        const large = new Map([
            ['oldest', half],
            ['older', half],
            ['newest', `${half}z`],
        ]);
        // The newest draft and the one before it would pass the bound by a character, so only the newest survives,
        // whole.
        expect(persistableAgentChatDrafts(large)).toEqual([['newest', `${half}z`]]);
    });
});
