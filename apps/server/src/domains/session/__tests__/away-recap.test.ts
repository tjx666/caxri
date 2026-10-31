import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatUsage,
    AgentProvider,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { WatchHub } from '../../watch';
import { ChatAwayRecap, isBriefAgentChatReply } from '../away-recap';

const respondedAt = Date.parse('2026-01-01T00:00:00Z');
const minute = 60_000;

const prompt: AgentChatItem = { id: 'prompt', type: 'userMessage', text: 'Fix it', createdAt: 1 };

function reply(text: string): AgentChatItem {
    return {
        id: `reply-${text.length}`,
        type: 'agentMessage',
        text,
        streaming: false,
    };
}

const toolWork = { id: 'tool', type: 'command' } as AgentChatItem;

function fixture({
    provider = 'claude',
    usage = { totalTokens: 1000, cacheTtlMinutes: 5, lastResponseAt: respondedAt },
    items = [prompt, toolWork, reply('Done.')],
    lastViewedAt = respondedAt - minute,
    watchedSessionId,
}: {
    provider?: AgentProvider;
    usage?: AgentChatUsage;
    items?: AgentChatItem[];
    lastViewedAt?: number;
    watchedSessionId?: string;
} = {}) {
    let now = respondedAt;
    const current = {
        awayRecap: undefined as AgentChatSnapshot['awayRecap'],
        isEnabled: true,
        isObservedRemotely: false,
        watchedSessionId,
    };
    const agentChat = {
        states: {
            terminalIds: () => ['chat'][Symbol.iterator](),
            get: () =>
                ({
                    projection: { snapshot: { items, usage, awayRecap: current.awayRecap } },
                }) as never,
        },
        idleLaunchId: vi.fn<(terminalId: string) => string | undefined>(() => 'launch'),
        isObservedRemotely: vi.fn(() => current.isObservedRemotely),
        recapAway: vi.fn<(terminalId: string, lastResponseAt: number) => Promise<string>>(
            (_terminalId, lastResponseAt) => {
                current.awayRecap = { text: 'Recap', lastResponseAt, generatedAt: now };
                return Promise.resolve('Recap');
            },
        ),
    };
    const maintenanceTurns = { holds: vi.fn(() => false) };
    const send = vi.fn<(event: ServerEvent) => void>();
    const write = vi.fn<StructuredLogger['write']>();
    const recap = new ChatAwayRecap({
        agentChat,
        database: {
            getTerminal: vi.fn(() => ({ provider, sessionId: 'session' }) as never),
            getSession: vi.fn(
                () => ({ id: 'session', primaryAgentTerminalId: 'chat', lastViewedAt }) as never,
            ),
        },
        maintenanceTurns,
        logger: { write } as unknown as StructuredLogger,
        presence: { isSettled: () => true, watchedSessionId: () => current.watchedSessionId },
        send,
        settings: () => ({ 'agentChat.awayRecap.enabled': current.isEnabled }),
        watchHub: {} as WatchHub,
        now: () => now,
    });
    return {
        agentChat,
        current,
        maintenanceTurns,
        recap,
        send,
        lastRecord: () => {
            const [level, , options] = write.mock.lastCall ?? [];
            return { level, ...options?.fields };
        },
        advanceTo: (minutes: number) => {
            now = respondedAt + minutes * minute;
        },
    };
}

describe('ChatAwayRecap', () => {
    it('recaps an unseen reply once it is due, announces it, and records the outcome', async () => {
        const f = fixture();
        f.advanceTo(2.9);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).not.toHaveBeenCalled();
        f.advanceTo(3);
        expect(f.recap.isPending('chat')).toBe(true);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).toHaveBeenCalledWith('chat', respondedAt);
        expect(f.send).toHaveBeenCalledWith({
            event: 'agent.recapChanged',
            payload: { sessionId: 'session' },
        });
        expect(f.lastRecord()).toMatchObject({
            level: 'info',
            outcome: 'generated',
            awayMs: 3 * minute,
            length: 5,
        });
        expect(f.recap.isPending('chat')).toBe(false);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).toHaveBeenCalledOnce();
    });

    it('keeps a Chat with no known cache expiry pending until it is idle', async () => {
        const f = fixture({ usage: { totalTokens: 1000, lastResponseAt: respondedAt } });
        f.agentChat.idleLaunchId.mockReturnValue(undefined);
        f.advanceTo(60);
        await f.recap.sweep();
        expect(f.recap.isPending('chat')).toBe(true);
        f.agentChat.idleLaunchId.mockReturnValue('launch');
        await f.recap.sweep();
        expect(f.agentChat.recapAway).toHaveBeenCalledOnce();
    });

    it.each([
        ['watches the Session', { watchedSessionId: 'session' }, false],
        ['left after the reply', { lastViewedAt: respondedAt + 1 }, false],
        ['follows it on a phone', {}, true],
    ] as const)('settles silently when the user %s', async (_, options, isObservedRemotely) => {
        const f = fixture(options);
        f.current.isObservedRemotely = isObservedRemotely;
        f.advanceTo(3);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).not.toHaveBeenCalled();
        expect(f.recap.isPending('chat')).toBe(false);
    });

    it('skips a brief reply that the Activity excerpt already quotes in full', async () => {
        const f = fixture({ items: [prompt, reply('Yes, it is.')] });
        f.advanceTo(3);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).not.toHaveBeenCalled();
        expect(f.lastRecord()).toMatchObject({ outcome: 'skipped', reason: 'brief_reply' });
    });

    it('retries a busy Chat while the cache holds, then gives up once it cooled', async () => {
        const f = fixture();
        f.agentChat.idleLaunchId.mockReturnValue(undefined);
        f.advanceTo(3);
        await f.recap.sweep();
        expect(f.agentChat.recapAway).not.toHaveBeenCalled();
        expect(f.recap.isPending('chat')).toBe(true);
        f.agentChat.idleLaunchId.mockReturnValue('launch');
        f.advanceTo(4.5);
        await f.recap.sweep();
        expect(f.lastRecord()).toMatchObject({ outcome: 'skipped', reason: 'cache_expired' });
        expect(f.agentChat.recapAway).not.toHaveBeenCalled();
        expect(f.recap.isPending('chat')).toBe(false);
    });

    it('records a failure by its closed reason and does not retry it', async () => {
        const f = fixture();
        f.agentChat.recapAway.mockRejectedValue(new CaxriError('TIMEOUT', 'slow'));
        f.advanceTo(3);
        await f.recap.sweep();
        expect(f.lastRecord()).toMatchObject({
            level: 'warn',
            outcome: 'failed',
            reason: 'timeout',
        });
        expect(f.send).not.toHaveBeenCalled();
        await f.recap.sweep();
        expect(f.agentChat.recapAway).toHaveBeenCalledOnce();
    });

    it('does nothing for a provider without side questions or when the setting is off', async () => {
        const grok = fixture({ provider: 'grok' });
        grok.advanceTo(3);
        await grok.recap.sweep();
        expect(grok.agentChat.recapAway).not.toHaveBeenCalled();
        const off = fixture();
        off.current.isEnabled = false;
        off.advanceTo(3);
        expect(off.recap.isPending('chat')).toBe(false);
        await off.recap.sweep();
        expect(off.agentChat.recapAway).not.toHaveBeenCalled();
    });
});

describe('isBriefAgentChatReply', () => {
    it('is brief for short Agent text after the prompt, ignoring reasoning', () => {
        const reasoning = { id: 'r', type: 'reasoning' } as AgentChatItem;
        expect(isBriefAgentChatReply([prompt, reasoning, reply('Yes.')])).toBe(true);
    });

    it('is not brief after tool work, a long answer, or with no prompt in view', () => {
        expect(isBriefAgentChatReply([prompt, toolWork, reply('Done.')])).toBe(false);
        const long = reply('a'.repeat(300));
        expect(isBriefAgentChatReply([prompt, long])).toBe(false);
        expect(isBriefAgentChatReply([reply('Yes.')])).toBe(false);
    });
});
