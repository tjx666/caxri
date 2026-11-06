import type { ProjectRecord } from '@caxri/protocol';
import { canUseAgentChat } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    didClaimFreshChatSession,
    FRESH_CHAT_AGENT_SLOT,
    FRESH_CHAT_PROJECT_SLOT,
    freshChatKind,
    freshChatKinds,
    freshChatProjects,
    freshChatSentenceParts,
    markFreshChatSession,
    useFreshChatSessionStore,
} from '../fresh-chat-session';

describe('freshChatKind', () => {
    it('follows the configured default Agent, then the last pick, before any fixed provider', () => {
        expect(freshChatKind('codex', true, 'claude')).toBe('codex');
        expect(freshChatKind(null, true, 'codex')).toBe('codex');
        expect(freshChatKind(null, true, undefined)).toBe(freshChatKinds()[0]);
    });

    it('opens no fresh Chat while Agents open as Terminals or the default cannot open in Chat', () => {
        expect(freshChatKind('codex', false, undefined)).toBeUndefined();
        expect(freshChatKind(null, undefined, 'codex')).toBeUndefined();
        expect(freshChatKind('shell', true, 'codex')).toBeUndefined();
    });

    it('keeps repeating a last pick that cannot open in Chat', () => {
        expect(freshChatKind(null, true, 'shell')).toBeUndefined();
    });
});

describe('freshChatKinds', () => {
    it('lists only Chat-capable Agents', () => {
        expect(freshChatKinds().length).toBeGreaterThan(0);
        expect(freshChatKinds().every((kind) => canUseAgentChat(kind))).toBe(true);
    });
});

describe('freshChatProjects', () => {
    it('orders Projects by most recent visit', () => {
        const project = (id: string, lastVisitedAt: number) =>
            ({ id, lastVisitedAt }) as ProjectRecord;
        expect(
            freshChatProjects([project('a', 1), project('b', 3), project('c', 2)]).map(
                ({ id }) => id,
            ),
        ).toEqual(['b', 'c', 'a']);
    });
});

describe('freshChatSentenceParts', () => {
    it('keeps each locale’s word order around the two slots', () => {
        const parts = (sentence: string) =>
            freshChatSentenceParts(sentence).map(({ part }) => part);
        expect(parts(`Start in ${FRESH_CHAT_PROJECT_SLOT} with ${FRESH_CHAT_AGENT_SLOT}`)).toEqual([
            'Start in',
            FRESH_CHAT_PROJECT_SLOT,
            'with',
            FRESH_CHAT_AGENT_SLOT,
        ]);
        expect(parts(`在 ${FRESH_CHAT_PROJECT_SLOT} 中使用 ${FRESH_CHAT_AGENT_SLOT} 开始`)).toEqual(
            ['在', FRESH_CHAT_PROJECT_SLOT, '中使用', FRESH_CHAT_AGENT_SLOT, '开始'],
        );
    });
});

describe('fresh Chat Session set', () => {
    it('claims a marked Session exactly once', () => {
        markFreshChatSession('session-1');
        expect(useFreshChatSessionStore.getState().sessionIds.has('session-1')).toBe(true);
        expect(didClaimFreshChatSession('session-1')).toBe(true);
        expect(didClaimFreshChatSession('session-1')).toBe(false);
        expect(didClaimFreshChatSession('session-2')).toBe(false);
    });
});
