import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDelegationReceipt, TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { writeClaudeTranscript } from '../../__tests__/create-test-domain-services';
import type { AgentCoordinator } from '../../agents';
import { CaxriDatabase } from '../../db';
import type { TerminalManager } from '../manager';
import { createInterruptedTerminalRestorer } from '../restore';
import { TerminalRestoreSupervisor } from '../restore-supervisor';

const FROZEN_LAUNCH = { executable: 'codex', args: ['--model', 'frozen-model'] };

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-restore-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'codex');
    database.rebindAgentSession(terminal!.id, 'codex', 'conversation-1');
    database.updateTerminalState(terminal!.id, 'interrupted');
    database.updateAgentProcessState(terminal!.id, 'interrupted');
    const restart = vi.fn<TerminalManager['restart']>(() =>
        Promise.resolve({ lastProcessState: 'running' } as TerminalRecord),
    );
    const restore = createInterruptedTerminalRestorer({
        coordinator: {
            prepareTerminalResume: vi.fn(),
            prepareTerminalStart: vi.fn(),
            probeTerminal: vi.fn(),
        } as unknown as AgentCoordinator,
        database,
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        send: vi.fn(),
        terminalDirectoryIdentity: () =>
            Promise.resolve({ device: '1', inode: '1', path: directory }),
        terminalRestores: new TerminalRestoreSupervisor(),
        terminals: { restart } as unknown as TerminalManager,
        userDataPath: directory,
        visibleGridWaitMs: 0,
    });
    const delegate = (status: AgentDelegationReceipt['status']) => {
        const delegationId = randomUUID();
        database.agentDelegations.insert({
            receipt: {
                delegationId,
                projectId: project.id,
                sessionId: session.id,
                terminalId: terminal!.id,
                provider: 'codex',
                status,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
            },
            principal: { kind: 'human-cli', id: 'owner' },
            input: {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
                prompt: 'Synthetic task',
            },
            fingerprint: 'fingerprint',
            promptDigest: 'digest',
            frozenLaunch: FROZEN_LAUNCH,
            providerSessionId: 'conversation-1',
        });
    };
    return { delegate, restart, restore: () => restore(session.id) };
}

describe('Interrupted Terminal restore of a delegated Agent', () => {
    it('resumes the conversation with the frozen launch once every task settled', async () => {
        const f = await fixture();
        f.delegate('completed');

        await f.restore();

        expect(f.restart).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                launchAgent: true,
                resumeAgentSessionId: 'conversation-1',
                launchSettings: FROZEN_LAUNCH,
            }),
        );
    });

    it('restores only the Shell while a task is still active on the Terminal', async () => {
        const f = await fixture();
        f.delegate('completed');
        f.delegate('running');

        await f.restore();

        expect(f.restart).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ launchAgent: false, resumeAgentSessionId: undefined }),
        );
        expect(f.restart.mock.calls[0]?.[1]).not.toHaveProperty('launchSettings');
    });

    it('resumes an Agent no delegation touched with its ordinary launch', async () => {
        const f = await fixture();

        await f.restore();

        expect(f.restart.mock.calls[0]?.[1]).toMatchObject({
            launchAgent: true,
            resumeAgentSessionId: 'conversation-1',
        });
        expect(f.restart.mock.calls[0]?.[1]).not.toHaveProperty('launchSettings');
    });
});

describe('Interrupted Terminal restore of a Claude Code Agent', () => {
    async function claudeFixture() {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-restore-claude-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const agentSessionId = randomUUID();
        const project = database.createProject(directory);
        const { session, terminal } = database.createSession(project.id, 'claude');
        database.rebindAgentSession(terminal!.id, 'claude', agentSessionId);
        database.updateTerminalState(terminal!.id, 'suspended');
        database.updateAgentProcessState(terminal!.id, 'suspended');
        const environment = { homeDirectory: directory, variables: {} };
        const coordinator = {
            prepareTerminalResume: vi.fn(),
            prepareTerminalStart: vi.fn(),
            probeTerminal: vi.fn(),
        };
        const logger = { write: vi.fn<StructuredLogger['write']>() };
        const restart = vi.fn<TerminalManager['restart']>(() =>
            Promise.resolve({ lastProcessState: 'running' } as TerminalRecord),
        );
        const restore = createInterruptedTerminalRestorer({
            agentEnvironment: environment,
            coordinator: coordinator as unknown as AgentCoordinator,
            database,
            logger: logger as unknown as StructuredLogger,
            send: vi.fn(),
            terminalDirectoryIdentity: () =>
                Promise.resolve({ device: '1', inode: '1', path: directory }),
            terminalRestores: new TerminalRestoreSupervisor(),
            terminals: { restart } as unknown as TerminalManager,
            userDataPath: directory,
            visibleGridWaitMs: 0,
        });
        return {
            agentSessionId,
            coordinator,
            logger,
            restart,
            restore: () => restore(session.id),
            writeTranscript: () => writeClaudeTranscript(directory, directory, agentSessionId),
        };
    }

    it('starts a fresh Agent when the conversation was suspended before its first prompt', async () => {
        const f = await claudeFixture();

        await f.restore();

        expect(f.restart.mock.calls[0]?.[1]).toMatchObject({
            launchAgent: true,
            resumeAgentSessionId: undefined,
        });
        expect(f.coordinator.prepareTerminalStart).toHaveBeenCalledOnce();
        expect(f.coordinator.prepareTerminalResume).not.toHaveBeenCalled();
        const skipped = f.logger.write.mock.calls.find(
            ([, event]) => event === 'terminal.resume_skipped',
        );
        expect(skipped?.[2]).toMatchObject({
            fields: { reason: 'conversation_unwritten', source: 'restore' },
        });
    });

    it('resumes the conversation once Claude Code has written its transcript', async () => {
        const f = await claudeFixture();
        await f.writeTranscript();

        await f.restore();

        expect(f.restart.mock.calls[0]?.[1]).toMatchObject({
            launchAgent: true,
            resumeAgentSessionId: f.agentSessionId,
        });
        expect(f.coordinator.prepareTerminalResume).toHaveBeenCalledOnce();
    });
});
