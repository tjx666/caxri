import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Principal, SessionRecord, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { CaxriError, defaultAppSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTestTerminalManager } from '../../__tests__/support/terminal';
import { createAgentCommandHandlers } from '../agent-dispatch/handlers';
import { AgentDispatchService } from '../agent-dispatch/service';
import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { AgentCoordinator } from '../agents';
import { CompactionReadiness, defaultAgentEnvironment, LongPasteService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionCompaction } from '../session/compaction';
import type { TerminalManager } from '../terminal';
import { TerminalRestoreSupervisor } from '../terminal';
import { InFlightLaunches } from '../terminal/in-flight-launches';
import {
    createTerminalAgentExactInputHandler,
    createTerminalBinaryInputHandler,
    createTerminalInputHandler,
} from '../terminal/input';
import { createInterruptedTerminalRestorer } from '../terminal/restore';
import { decideTerminalSuspensions } from '../terminal/suspension-policy';

const PRINCIPAL: Principal = { kind: 'human-cli', id: 'human-cli:test' };

/**
 * A Chat Terminal has no PTY, so every PTY-only operation must refuse it before any side effect.
 */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-guards-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session } = database.createSession(project.id, null);
    const terminal = database.createTerminal(session.id, 'codex', undefined, 'chat');
    database.rebindAgentSession(terminal.id, 'codex', 'conversation-1');
    database.updateTerminalState(terminal.id, 'interrupted');
    database.updateAgentProcessState(terminal.id, 'interrupted');
    const sideEffects = {
        agentLaunchId: vi.fn(() => 'launch-1'),
        agentProcessId: vi.fn(() => 42),
        consumeAttention: vi.fn(() => true),
        observeInput: vi.fn(() => true),
        processId: vi.fn(() => 42),
        restart: vi.fn(),
        start: vi.fn(),
        write: vi.fn(() => true),
        writeAcknowledged: vi.fn(() => Promise.resolve(true)),
        writeAgent: vi.fn(() => Promise.resolve(true)),
        writeAgentExact: vi.fn(() => true),
    };
    const terminals = {
        ...sideEffects,
        launches: new InFlightLaunches(),
    } as unknown as TerminalManager;
    const coordinator = {
        hasIdleProof: () => true,
        observeInput: sideEffects.observeInput,
        prepareTerminalResume: vi.fn(),
        prepareTerminalStart: vi.fn(),
        probeTerminal: vi.fn(),
    } as unknown as AgentCoordinator;
    return { coordinator, database, directory, project, session, sideEffects, terminal, terminals };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const rejections: Array<[string, (f: Fixture) => unknown]> = [
    [
        'terminal.input',
        (f) =>
            createTerminalInputHandler({
                coordinator: f.coordinator,
                database: f.database,
                send: vi.fn(),
                terminals: f.terminals,
            })({ terminalId: f.terminal.id, data: 'hello\r' }),
    ],
    [
        'terminal.inputBinary',
        (f) =>
            createTerminalBinaryInputHandler({
                coordinator: f.coordinator,
                database: f.database,
                send: vi.fn(),
                terminals: f.terminals,
            })({ terminalId: f.terminal.id, data: '\u{1B}[M', expectedAgentLaunchId: 'launch-1' }),
    ],
    [
        'terminal.inputAgentExact',
        async (f) =>
            createTerminalAgentExactInputHandler({
                coordinator: f.coordinator,
                database: f.database,
                send: vi.fn(),
                terminals: f.terminals,
            })({ terminalId: f.terminal.id, data: 'x', expectedAgentLaunchId: 'launch-1' }),
    ],
    [
        'terminal.sendInternal',
        async (f) => {
            const handlers = createAgentCommandHandlers({
                coordinator: f.coordinator,
                database: f.database,
                dispatch: {} as AgentDispatchService,
                emit: vi.fn(),
                mainOwned: () => {
                    throw new Error('Unexpected public handler call');
                },
                terminals: f.terminals,
            });
            return handlers['terminal.sendInternal']({
                attentionEpoch: 0,
                enter: true,
                terminalId: f.terminal.id,
                text: 'reply',
            });
        },
    ],
    [
        'dispatch resume',
        (f) => {
            const service = new AgentDispatchService({
                logger: { write: vi.fn() } as never,
                database: f.database,
                coordinator: f.coordinator,
                terminals: f.terminals,
                endpoints: {} as AgentEndpointLifecycle,
                launchSettings: () => ({ executable: '/fixture/codex', args: [] }),
                terminalDirectoryIdentity: (path) =>
                    Promise.resolve({ device: '1', inode: '1', path }),
                terminalWorkingDirectory: ({ defaultRoot }) => Promise.resolve(defaultRoot),
                emit: vi.fn(),
            });
            onTestFinished(() => service.close());
            return service.resume('dispatch-chat', PRINCIPAL, {
                projectId: f.project.id,
                sessionId: f.session.id,
                terminalId: f.terminal.id,
                providerSessionId: 'conversation-1',
            });
        },
    ],
    ['manager restart', (f) => managerFor(f).restart(f.terminal.id, { launchAgent: true })],
    ['manager start', (f) => managerFor(f).start(f.database.getTerminal(f.terminal.id)!)],
    [
        'long paste',
        (f) => {
            const settings = {
                ...structuredClone(defaultAppSettings),
                ['terminal.longPasteThreshold']: 10,
            };
            const service = new LongPasteService(
                f.directory,
                f.database,
                () => settings,
                () => 'launch-1',
            );
            onTestFinished(() => service.close());
            return service.prepare({ terminalId: f.terminal.id, content: 'x'.repeat(100) });
        },
    ],
];

function managerFor(f: Fixture): TerminalManager {
    const spawn = vi.fn(() => {
        throw new Error('A Chat Terminal must not spawn a PTY');
    });
    return createTestTerminalManager(
        f.database,
        () => {},
        new StructuredLogger(join(f.directory, 'logs')),
        { spawn },
    );
}

describe('Chat Terminal PTY guards', () => {
    it.each(rejections)('%s rejects a Chat Terminal before any side effect', async (_, run) => {
        const f = await fixture();
        const filesBefore = await readdir(f.directory);
        const before = f.database.getTerminal(f.terminal.id);
        await expect(Promise.try(() => run(f))).rejects.toSatisfy(
            (error) => error instanceof CaxriError && error.code === 'UNAVAILABLE',
        );
        for (const effect of Object.values(f.sideEffects)) expect(effect).not.toHaveBeenCalled();
        expect(f.database.getTerminal(f.terminal.id)).toEqual(before);
        expect(
            f.database.database
                .prepare('SELECT count(*) AS count FROM agent_dispatch_receipts')
                .get(),
        ).toEqual({ count: 0 });
        expect((await readdir(f.directory)).filter((name) => name !== 'logs')).toEqual(
            filesBefore.filter((name) => name !== 'logs'),
        );
    });

    it('compaction reports a Chat Terminal as unsupported without typing into it', async () => {
        const f = await fixture();
        const readTranscript = vi.fn();
        const service = new SessionCompaction({
            database: f.database,
            readiness: new CompactionReadiness(),
            terminals: f.terminals,
            coordinator: f.coordinator,
            environment: defaultAgentEnvironment(),
            readTranscript,
        });
        expect(await service.run()).toEqual({
            items: [{ sessionId: f.session.id, outcome: 'unsupported' }],
            deferred: 0,
        });
        expect(f.sideEffects.writeAgentExact).not.toHaveBeenCalled();
        expect(readTranscript).not.toHaveBeenCalled();
    });

    it('restore leaves an interrupted Chat Terminal for its lazy resume', async () => {
        const f = await fixture();
        await createInterruptedTerminalRestorer({
            coordinator: f.coordinator,
            database: f.database,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            send: vi.fn(),
            terminalDirectoryIdentity: () =>
                Promise.resolve({ device: '1', inode: '1', path: f.directory }),
            terminalRestores: new TerminalRestoreSupervisor(),
            terminals: f.terminals,
            userDataPath: f.directory,
            visibleGridWaitMs: 0,
        })(f.session.id);
        expect(f.sideEffects.restart).not.toHaveBeenCalled();
    });

    it('suspension never parks a Chat Terminal', () => {
        const decide = (surface: TerminalSurface) =>
            decideTerminalSuspensions({
                deselectedAt: () => 0,
                now: 1_000_000_000,
                sample: () => ({ launchedAt: 0, turnInFlight: false }),
                selectedSessionId: 'other-session',
                session: () => ({ id: 'session-a' }) as SessionRecord,
                settings: {
                    'terminal.suspendIdleAgents': 'off',
                    'terminal.suspendUntouchedAgents': true,
                },
                startedAt: 0,
                terminals: [
                    {
                        id: 'terminal-1',
                        sessionId: 'session-a',
                        kind: 'codex',
                        provider: 'codex',
                        surface,
                        cwd: '/fixture/project',
                        title: 'codex',
                        icon: 'codex',
                        orderIndex: 0,
                        lastProcessState: 'running',
                        lastAgentProcessState: 'running',
                        createdAt: 0,
                        updatedAt: 0,
                    } as TerminalRecord,
                ],
            });
        expect(decide('chat')).toEqual([]);
        expect(decide('pty')).toHaveLength(1);
    });
});
