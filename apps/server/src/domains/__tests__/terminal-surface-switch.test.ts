import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentCoordinator } from '../agents';
import { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';
import { createTerminalSurfaceSwitchHandler } from '../terminal-surface-switch';

async function fixture({
    agentSessionId = 'thread-1',
    provider = 'codex',
    surface = 'pty',
}: {
    agentSessionId?: string | null;
    provider?: AgentProvider;
    surface?: TerminalSurface;
} = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-surface-switch-'));
    const directory = await realpath(temporary);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const project = database.createProject(projectRoot);
    const { session } = database.createSession(project.id, null);
    const created = database.createTerminal(
        session.id,
        provider,
        projectRoot,
        surface === 'chat' ? 'chat' : undefined,
    );
    if (agentSessionId) database.rebindAgentSession(created.id, provider, agentSessionId);
    database.updateAgentProcessState(created.id, 'running');
    const order: string[] = [];
    const chat = {
        close: vi.fn((terminalId: string) => {
            order.push(`chat.close:${database.getTerminal(terminalId)?.surface ?? 'pty'}`);
            return Promise.resolve();
        }),
        hasActiveTurn: vi.fn(() => false),
        restart: vi.fn((terminalId: string) => {
            order.push(`chat.restart:${database.getTerminal(terminalId)?.surface ?? 'pty'}`);
            return Promise.resolve(database.getTerminal(terminalId)!);
        }),
    };
    const terminals = {
        suspend: vi.fn(() => {
            order.push('pty.stop');
            return Promise.resolve();
        }),
        restart: vi.fn((terminalId: string) => {
            order.push(`pty.restart:${database.getTerminal(terminalId)?.surface ?? 'pty'}`);
            return Promise.resolve(database.getTerminal(terminalId)!);
        }),
    };
    const coordinator = { prepareTerminalResume: vi.fn(), probeTerminal: vi.fn() };
    const logger = { write: vi.fn() };
    const send = vi.fn();
    const handler = createTerminalSurfaceSwitchHandler({
        agentEnvironment: { homeDirectory: directory, variables: {} },
        chat,
        coordinator: coordinator as unknown as AgentCoordinator,
        database,
        logger: logger as unknown as StructuredLogger,
        send,
        terminalDirectoryIdentity: () =>
            Promise.resolve({ path: projectRoot, device: 1, inode: 1 } as never),
        terminals: terminals as unknown as TerminalManager,
    });
    const terminal = database.getTerminal(created.id)!;
    function markPrimaryTurn(state: 'running' | 'waiting' | 'idle') {
        database.database
            .prepare(
                'UPDATE sessions SET primary_agent_terminal_id = ?, last_activity_state = ? WHERE id = ?',
            )
            .run(terminal.id, state, session.id);
    }
    function loggedOutcomes() {
        return logger.write.mock.calls.map(
            (call) => (call[2] as { fields: { outcome: string } }).fields.outcome,
        );
    }
    return {
        chat,
        coordinator,
        database,
        handler,
        loggedOutcomes,
        markPrimaryTurn,
        order,
        send,
        terminal,
        terminals,
    };
}

function surfaceOf(terminal: TerminalRecord | undefined): TerminalSurface {
    return terminal?.surface ?? 'pty';
}

describe('terminal.switchSurface', () => {
    it('stops the PTY, flips the surface, and resumes the bound conversation in Chat', async () => {
        const { chat, coordinator, database, handler, order, terminal, terminals } =
            await fixture();
        const result = await handler({
            terminalId: terminal.id,
            surface: 'chat',
            interruptTurn: false,
        });
        expect(result).toMatchObject({ status: 'switched', terminal: { surface: 'chat' } });
        expect(order).toEqual(['pty.stop', 'chat.restart:chat']);
        expect(terminals.suspend).toHaveBeenCalledWith(terminal.id, 'stopped', 'surfaceSwitched');
        expect(chat.close).not.toHaveBeenCalled();
        expect(coordinator.prepareTerminalResume).toHaveBeenCalledWith(terminal.id);
        expect(database.getTerminal(terminal.id)).toMatchObject({
            agentSessionId: 'thread-1',
            surface: 'chat',
        });
    });

    it('stops the Chat and resumes the same session in a PTY', async () => {
        const { coordinator, database, handler, order, terminal, terminals } = await fixture({
            surface: 'chat',
        });
        const result = await handler({
            terminalId: terminal.id,
            surface: 'pty',
            interruptTurn: false,
        });
        expect(result.status).toBe('switched');
        expect(order).toEqual(['chat.close:chat', 'pty.restart:pty']);
        expect(terminals.restart).toHaveBeenCalledWith(
            terminal.id,
            expect.objectContaining({ resumeAgentSessionId: 'thread-1' }),
        );
        expect(coordinator.probeTerminal).toHaveBeenCalledWith(terminal.id);
        expect(surfaceOf(database.getTerminal(terminal.id))).toBe('pty');
    });

    it('is a no-op when the Terminal already uses the requested surface', async () => {
        const { handler, order, terminal } = await fixture({ surface: 'chat' });
        await expect(
            handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
        ).resolves.toMatchObject({ status: 'switched' });
        expect(order).toEqual([]);
    });

    it('refuses an unbound Agent without touching its process', async () => {
        const { database, handler, loggedOutcomes, order, terminal } = await fixture({
            agentSessionId: null,
        });
        await expect(
            handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
        ).rejects.toThrow(/no conversation to continue yet/u);
        expect(order).toEqual([]);
        expect(surfaceOf(database.getTerminal(terminal.id))).toBe('pty');
        expect(loggedOutcomes()).toEqual(['unbound']);
    });

    it('refuses a Claude Code session whose transcript was never written', async () => {
        const { handler, order, terminal } = await fixture({ provider: 'claude' });
        await expect(
            handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
        ).rejects.toThrow(/Claude Code has no conversation/u);
        expect(order).toEqual([]);
    });

    it('rejects an Agent without Chat support', async () => {
        const { handler, terminal } = await fixture({ provider: 'grok' });
        await expect(
            handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
        ).rejects.toThrow(/Chat-capable/u);
    });

    it.each(['running', 'waiting'] as const)(
        'asks before ending a PTY turn the Session reports as %s',
        async (state) => {
            const { database, handler, loggedOutcomes, markPrimaryTurn, order, terminal } =
                await fixture();
            markPrimaryTurn(state);
            await expect(
                handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
            ).resolves.toEqual({ status: 'turnRunning' });
            expect(order).toEqual([]);
            expect(surfaceOf(database.getTerminal(terminal.id))).toBe('pty');
            await expect(
                handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: true }),
            ).resolves.toMatchObject({ status: 'switched' });
            expect(loggedOutcomes()).toEqual(['turnRunning', 'switched']);
        },
    );

    it('switches an idle primary PTY Agent without asking', async () => {
        const { handler, markPrimaryTurn, terminal } = await fixture();
        markPrimaryTurn('idle');
        await expect(
            handler({ terminalId: terminal.id, surface: 'chat', interruptTurn: false }),
        ).resolves.toMatchObject({ status: 'switched' });
    });

    it('asks before ending a running Chat turn', async () => {
        const { chat, handler, order, terminal } = await fixture({ surface: 'chat' });
        chat.hasActiveTurn.mockReturnValue(true);
        await expect(
            handler({ terminalId: terminal.id, surface: 'pty', interruptTurn: false }),
        ).resolves.toEqual({ status: 'turnRunning' });
        expect(order).toEqual([]);
        await handler({ terminalId: terminal.id, surface: 'pty', interruptTurn: true });
        expect(order).toEqual(['chat.close:chat', 'pty.restart:pty']);
    });

    it('logs a failed switch and leaves the error to the caller', async () => {
        const { handler, loggedOutcomes, terminal, terminals } = await fixture({
            surface: 'chat',
        });
        terminals.restart.mockRejectedValueOnce(new Error('spawn failed'));
        await expect(
            handler({ terminalId: terminal.id, surface: 'pty', interruptTurn: false }),
        ).rejects.toThrow('spawn failed');
        expect(loggedOutcomes()).toEqual(['failed']);
    });
});
