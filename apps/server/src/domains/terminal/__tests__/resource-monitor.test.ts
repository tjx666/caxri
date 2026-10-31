import type { ServerEvent, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { parseProcessTable, ProcessTable } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { TerminalResourceMonitor } from '../resource-monitor';

const terminal = {
    id: 'terminal-1',
    sessionId: 'session-1',
    kind: 'claude',
    provider: 'claude',
    title: 'Claude Code',
} as TerminalRecord;

function createMonitor(table: { current: string }, processId: { current?: number } = {}) {
    processId.current ??= 100;
    const events: ServerEvent[] = [];
    const monitor = new TerminalResourceMonitor({
        database: {
            getSession: () => ({ title: 'Tune the timeline' }) as SessionRecord,
            listTerminals: () => [terminal],
        },
        logger: { write: vi.fn() } as never,
        sampleProcessTable: () =>
            Promise.resolve(new ProcessTable(parseProcessTable(table.current))),
        send: (event) => events.push(event),
        terminals: { processId: () => processId.current },
        watchHub: { registerPoller: vi.fn() },
    });
    return { events, monitor };
}

function alertStates(events: readonly ServerEvent[]): string[] {
    return events.flatMap((event) =>
        event.event === 'terminal.resourceAlert' ? [event.payload.state] : [],
    );
}

const HIGH = `100 1 0.1 1024\n101 100 350.0 5000000`;
const NORMAL = `100 1 0.1 1024\n101 100 12.0 500000`;

describe('TerminalResourceMonitor', () => {
    it('maps running Terminals to their Session and PTY root', () => {
        const { monitor } = createMonitor({ current: NORMAL });
        expect(monitor.processes()).toEqual([
            {
                terminalId: 'terminal-1',
                sessionId: 'session-1',
                sessionTitle: 'Tune the timeline',
                kind: 'claude',
                provider: 'claude',
                title: 'Claude Code',
                processId: 100,
            },
        ]);
    });

    it('raises once per episode after consecutive high samples and clears on recovery', async () => {
        const table = { current: HIGH };
        const { events, monitor } = createMonitor(table);
        await monitor.sample();
        expect(events).toEqual([]);
        await monitor.sample();
        await monitor.sample();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            event: 'terminal.resourceAlert',
            payload: { state: 'raised', cpuPercent: 350.1, processCount: 2 },
        });
        table.current = NORMAL;
        await monitor.sample();
        expect(events.at(-1)).toMatchObject({ payload: { state: 'cleared' } });
        table.current = HIGH;
        await monitor.sample();
        await monitor.sample();
        expect(alertStates(events)).toEqual(['raised', 'cleared', 'raised']);
    });

    it('alerts and clears on an injected reading through the same consecutive-sample rule', async () => {
        const override: { current?: { cpuPercent: number } } = {};
        const events: ServerEvent[] = [];
        const monitor = new TerminalResourceMonitor({
            database: {
                getSession: () => ({ title: 'Tune the timeline' }) as SessionRecord,
                listTerminals: () => [terminal],
            },
            logger: { write: vi.fn() } as never,
            sampleProcessTable: () => Promise.resolve(new ProcessTable(parseProcessTable(NORMAL))),
            send: (event) => events.push(event),
            terminals: { processId: () => 100 },
            usageOverride: { intervalMs: 1_000, read: () => Promise.resolve(override.current) },
            watchHub: { registerPoller: vi.fn() },
        });
        override.current = { cpuPercent: 350 };
        await monitor.sample();
        expect(events).toEqual([]);
        await monitor.sample();
        expect(events.at(-1)).toMatchObject({
            payload: { state: 'raised', cpuPercent: 350, processCount: 2 },
        });
        override.current = undefined;
        await monitor.sample();
        expect(alertStates(events)).toEqual(['raised', 'cleared']);
    });

    it('does not alert on a single high sample', async () => {
        const table = { current: HIGH };
        const { events, monitor } = createMonitor(table);
        await monitor.sample();
        table.current = NORMAL;
        await monitor.sample();
        table.current = HIGH;
        await monitor.sample();
        expect(events).toEqual([]);
    });

    it('clears an alerted Terminal once it stops running', async () => {
        const processId: { current?: number } = { current: 100 };
        const { events, monitor } = createMonitor({ current: HIGH }, processId);
        await monitor.sample();
        await monitor.sample();
        processId.current = undefined;
        await monitor.sample();
        expect(alertStates(events)).toEqual(['raised', 'cleared']);
    });
});

describe('TerminalResourceMonitor.sessionResources', () => {
    const chat = { ...terminal, id: 'chat-1', title: 'Codex Chat' };
    const other = { ...terminal, id: 'terminal-2', sessionId: 'session-2' };
    // PTY root 100 with a child; Chat provider group leader 200 with a child; another Session's PTY 300.
    const TABLE = [
        '100 1 2.0 102400',
        '101 100 8.0 204800',
        '200 1 10.0 307200',
        '201 200 5.0 102400',
        '300 1 90.0 1048576',
    ].join('\n');

    const PTY_ROOTS: Record<string, number> = { 'terminal-1': 100, 'terminal-2': 300 };

    function createSessionMonitor(
        chatGroups: Array<{ pgid: number; terminalId: string }>,
        ptyRoots: Record<string, number> = PTY_ROOTS,
    ) {
        const terminals = [terminal, chat, other];
        const sample = vi.fn(() => Promise.resolve(new ProcessTable(parseProcessTable(TABLE))));
        const monitor = new TerminalResourceMonitor({
            chatProcessGroups: () => chatGroups,
            database: {
                getSession: () => {},
                listTerminals: (sessionId) =>
                    terminals.filter((entry) => !sessionId || entry.sessionId === sessionId),
            },
            logger: { write: vi.fn() } as never,
            sampleProcessTable: sample,
            send: vi.fn(),
            terminals: {
                processId: (id) => ptyRoots[id],
            },
            watchHub: { registerPoller: vi.fn() },
        });
        return { monitor, sample };
    }

    it('sums PTY Terminal trees and Chat provider trees of one Session only', async () => {
        const { monitor } = createSessionMonitor([
            { pgid: 200, terminalId: 'chat-1' },
            { pgid: 300, terminalId: 'terminal-2' },
        ]);
        await expect(monitor.sessionResources('session-1')).resolves.toEqual({
            cpuPercent: 25,
            memoryMb: 700,
            processCount: 4,
        });
    });

    it('returns null without sampling when nothing of the Session runs', async () => {
        const { monitor, sample } = createSessionMonitor([]);
        await expect(monitor.sessionResources('session-3')).resolves.toBeNull();
        expect(sample).not.toHaveBeenCalled();
    });

    it('returns null when the recorded roots have already exited', async () => {
        const { monitor } = createSessionMonitor([{ pgid: 999, terminalId: 'chat-1' }], {});
        await expect(monitor.sessionResources('session-1')).resolves.toBeNull();
    });
});
