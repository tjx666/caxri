import type { AgentChatUsage, AgentProvider } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { WatchHub } from '../../watch';
import { ChatIdleCompaction } from '../idle-compaction';

const respondedAt = Date.parse('2026-01-01T00:00:00Z');
const minute = 60_000;

function fixture({
    provider = 'claude',
    usage = { totalTokens: 250_000, cacheTtlMinutes: 60, lastResponseAt: respondedAt },
    isEnabled = true,
    primaryAgentTerminalId = 'chat',
}: {
    provider?: AgentProvider;
    usage?: AgentChatUsage;
    isEnabled?: boolean;
    primaryAgentTerminalId?: string;
} = {}) {
    let now = respondedAt;
    const current = { usage: usage as AgentChatUsage | undefined };
    const agentChat = {
        states: {
            terminalIds: () => ['chat'][Symbol.iterator](),
            get: () => ({ projection: { snapshot: { usage: current.usage } } }) as never,
        },
        idleLaunchId: vi.fn<(terminalId: string) => string | undefined>(() => 'launch'),
        compactIdle: vi.fn<
            (terminalId: string, launchId: string, reason?: 'batch' | 'idle') => Promise<void>
        >(() => Promise.resolve()),
    };
    const maintenanceTurns = { begin: vi.fn(), end: vi.fn(), holds: vi.fn(() => false) };
    const write = vi.fn<StructuredLogger['write']>();
    const settings = { 'agentChat.idleCompaction.enabled': isEnabled };
    const compaction = new ChatIdleCompaction({
        agentChat,
        database: {
            getTerminal: vi.fn(() => ({ provider, sessionId: 'session' }) as never),
            getSession: vi.fn(() => ({ primaryAgentTerminalId }) as never),
        },
        maintenanceTurns,
        logger: { write } as unknown as StructuredLogger,
        settings: () => settings,
        watchHub: {} as WatchHub,
        now: () => now,
    });
    return {
        agentChat,
        compaction,
        /**
         * The level and fields of the last idle compaction record.
         */
        lastRecord: () => {
            const [level, , options] = write.mock.lastCall ?? [];
            return { level, ...options?.fields };
        },
        current,
        maintenanceTurns,
        settings,
        write,
        advanceTo: (minutes: number) => {
            now = respondedAt + minutes * minute;
        },
    };
}

describe('ChatIdleCompaction', () => {
    it('compacts an idle Chat once, within the last tenth of its cache lifetime, as maintenance', async () => {
        const f = fixture();
        f.advanceTo(53);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).not.toHaveBeenCalled();
        f.advanceTo(54);
        await f.compaction.sweep();
        expect(f.maintenanceTurns.begin).toHaveBeenCalledWith('chat');
        expect(f.agentChat.compactIdle).toHaveBeenCalledWith('chat', 'launch', 'idle');
        expect(f.write).toHaveBeenCalledWith('info', 'session.idle_compaction', {
            durationMs: 0,
            fields: {
                terminalId: 'chat',
                provider: 'claude',
                contextTokens: 250_000,
                idleMs: 54 * minute,
                outcome: 'submitted',
            },
        });
        f.advanceTo(55);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).toHaveBeenCalledOnce();
    });

    it('waits through a busy Chat and gives up once the cache expired', async () => {
        const f = fixture();
        f.agentChat.idleLaunchId.mockReturnValue(undefined);
        f.advanceTo(55);
        await f.compaction.sweep();
        expect(f.write).not.toHaveBeenCalled();
        f.advanceTo(60);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).not.toHaveBeenCalled();
        expect(f.lastRecord()).toMatchObject({ level: 'info', outcome: 'cache_expired' });
    });

    it('records a refused compaction, closes its maintenance window, and does not retry it', async () => {
        const f = fixture();
        f.agentChat.compactIdle.mockRejectedValue(new CaxriError('CONFLICT', 'moved on'));
        f.advanceTo(54);
        await f.compaction.sweep();
        f.advanceTo(55);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).toHaveBeenCalledOnce();
        expect(f.maintenanceTurns.end).toHaveBeenCalledWith('chat', 'undelivered');
        expect(f.lastRecord()).toMatchObject({ level: 'info', outcome: 'changed' });
    });

    it('logs an unexpected failure at warn with its message', async () => {
        const f = fixture();
        f.agentChat.compactIdle.mockRejectedValue(new Error('provider crashed'));
        f.advanceTo(54);
        await f.compaction.sweep();
        expect(f.lastRecord()).toMatchObject({
            level: 'warn',
            outcome: 'failed',
            error: 'provider crashed',
        });
    });

    it('waits while another compaction holds the maintenance window', async () => {
        const f = fixture();
        f.maintenanceTurns.holds.mockReturnValue(true);
        f.advanceTo(54);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).not.toHaveBeenCalled();
        f.maintenanceTurns.holds.mockReturnValue(false);
        f.advanceTo(55);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).toHaveBeenCalledOnce();
    });

    it('tries again after the next response restarts the cache', async () => {
        const f = fixture();
        f.advanceTo(54);
        await f.compaction.sweep();
        f.current.usage = { ...f.current.usage!, lastResponseAt: respondedAt + 54 * minute };
        f.advanceTo(108);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['the setting is off', { isEnabled: false }],
        ['a Codex Chat', { provider: 'codex' as const }],
        ["a Chat that is not its Session's primary Agent", { primaryAgentTerminalId: 'other' }],
        [
            'a small context',
            { usage: { totalTokens: 60_000, cacheTtlMinutes: 60, lastResponseAt: respondedAt } },
        ],
        [
            'a five-minute cache',
            { usage: { totalTokens: 250_000, cacheTtlMinutes: 5, lastResponseAt: respondedAt } },
        ],
        ['no response yet', { usage: { totalTokens: 250_000, cacheTtlMinutes: 60 } }],
    ])('leaves the Chat alone for %s', async (_name, options) => {
        const f = fixture(options);
        f.advanceTo(4.5);
        expect(f.compaction.isPending('chat')).toBe(false);
        await f.compaction.sweep();
        f.advanceTo(55);
        await f.compaction.sweep();
        expect(f.agentChat.compactIdle).not.toHaveBeenCalled();
        expect(f.maintenanceTurns.begin).not.toHaveBeenCalled();
    });
});

describe('ChatIdleCompaction.isPending', () => {
    it('holds an eligible Chat from its response until the compaction is attempted', async () => {
        const f = fixture();
        f.advanceTo(30);
        expect(f.compaction.isPending('chat')).toBe(true);
        f.advanceTo(54);
        expect(f.compaction.isPending('chat')).toBe(true);
        await f.compaction.sweep();
        expect(f.compaction.isPending('chat')).toBe(false);
    });

    it.each([
        ['refused', new CaxriError('CONFLICT', 'moved on')],
        ['unsupported', new CaxriError('VALIDATION', 'no compact command')],
        ['failed', new Error('provider crashed')],
    ])('releases the Chat once its compaction was %s', async (_name, error) => {
        const f = fixture();
        f.agentChat.compactIdle.mockRejectedValue(error);
        f.advanceTo(54);
        await f.compaction.sweep();
        expect(f.compaction.isPending('chat')).toBe(false);
    });

    it('releases a busy Chat once its cache expired', () => {
        const f = fixture();
        f.agentChat.idleLaunchId.mockReturnValue(undefined);
        f.advanceTo(59.9);
        expect(f.compaction.isPending('chat')).toBe(true);
        f.advanceTo(60);
        expect(f.compaction.isPending('chat')).toBe(false);
    });

    it("does not hold a Chat still over the threshold for the compaction's own response, but does for the next one", async () => {
        const f = fixture();
        f.advanceTo(54);
        await f.compaction.sweep();
        // The compaction's turn finishes as a response that restarts the cache, still above the threshold.
        f.current.usage = { ...f.current.usage!, lastResponseAt: respondedAt + 55 * minute };
        f.advanceTo(56);
        expect(f.compaction.isPending('chat')).toBe(false);
        // The user's next message starts a new response, which is held again.
        f.current.usage = { ...f.current.usage, lastResponseAt: respondedAt + 120 * minute };
        f.advanceTo(121);
        expect(f.compaction.isPending('chat')).toBe(true);
    });
});
