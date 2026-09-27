import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeHookAdapter } from '../../providers/claude/hooks';
import { codexHookAdapter } from '../../providers/codex/hooks';
import type { AgentLifecycleSignal, AgentSignalDecision } from '../contract';
import { AgentHookManager } from '../manager';
import { hookBridgeEnvironment } from './server.fixture';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Covers what the hook boundary records about itself rather than what it installs: the per-launch aggregate that
 * survives per-signal deduplication, the audit trail for user-global config writes, and health state transitions.
 */
describe('AgentHookManager observability', () => {
    it('aggregates one launch summary, audits config writes, and records health transitions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-observability-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        // Only Codex is under observation; keep the Claude default from adding a second install write.
        settings.claude.hooks.enabled = false;
        settings.grok.hooks.enabled = false;
        const signals = vi.fn<(signal: AgentLifecycleSignal) => AgentSignalDecision>(
            () => 'accepted',
        );
        const logger = new StructuredLogger(join(directory, 'logs'), 'server-core', 'info');
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: signals,
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });
        const runBridge = async (
            bridge: string,
            environment: NodeJS.ProcessEnv,
            phase: string,
            payload?: Record<string, unknown>,
        ): Promise<void> => {
            const invocation = execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', phase],
                { env: hookBridgeEnvironment(environment) },
            );
            if (payload) invocation.child.stdin?.end(JSON.stringify(payload));
            await invocation;
        };

        try {
            await manager.initialize(settings);
            const bridge = join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge');
            const environment = manager.terminalEnvironment('terminal-1', 'codex');

            await runBridge(bridge, environment, 'turnStarted');
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(1));
            await runBridge(bridge, environment, 'shellToolStarted', {
                cwd: '/tmp/caxri-observability-fixture',
                tool_input: { command: 'git status' },
                tool_use_id: 'toolu_ordinary',
            });
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(2));
            await runBridge(bridge, environment, 'shellToolStarted', {
                cwd: '/tmp/caxri-observability-fixture',
                tool_input: { command: 'git worktree add ../feature feature' },
                tool_use_id: 'toolu_observability',
            });
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(3));
            signals.mockReturnValueOnce('staleLaunch');
            await runBridge(bridge, environment, 'turnFinished');
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(4));

            manager.endTerminalLaunch('terminal-1');
            settings.codex.hooks.enabled = false;
            await manager.reconcile(settings);

            await logger.flush();
            const logSource = await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8');
            const logRecords = logSource
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            const fieldsOf = (event: string): Record<string, unknown> | undefined =>
                logRecords.find((record) => record.event === event)?.fields as
                    Record<string, unknown> | undefined;

            /**
             * The aggregate preserves volume even when ordinary and worktree signals share the same phase.
             */
            expect(fieldsOf('agent_hooks.launch_summary')).toMatchObject({
                accepted: 3,
                ignored: 1,
                ignoredStaleLaunch: 1,
                phaseShellToolStarted: 2,
                phaseTurnFinished: 1,
                phaseTurnStarted: 1,
                provider: 'codex',
                rejected: 0,
                signals: 4,
                terminalId: 'terminal-1',
            });
            expect(fieldsOf('agent_hooks.launch_summary')).toHaveProperty('firstSignalMs');

            /**
             * The worktree-following path is only observable through these existence flags; the reported directory and
             * the classified command must never reach the log.
             */
            const shellToolLog = logRecords.find(
                (record) =>
                    record.event === 'agent_hooks.signal_accepted' &&
                    (record.fields as Record<string, unknown> | undefined)?.phase ===
                        'shellToolStarted' &&
                    (record.fields as Record<string, unknown> | undefined)?.worktreeCreateIntent ===
                        true,
            );
            expect(shellToolLog).toMatchObject({
                fields: { hasAgentCwd: true, worktreeCreateIntent: true },
            });
            expect(logSource).not.toContain('caxri-observability-fixture');
            expect(logSource).not.toContain('git worktree add');

            const configWrites = logRecords
                .filter((record) => record.event === 'agent_hooks.config_written')
                .map((record) => record.fields as Record<string, unknown>);
            expect(configWrites).toEqual([
                expect.objectContaining({
                    action: 'install',
                    fromStatus: 'absent',
                    provider: 'codex',
                }),
                expect.objectContaining({ action: 'remove', provider: 'codex' }),
            ]);

            const healthTransitions = logRecords
                .filter((record) => record.event === 'agent_hooks.health_changed')
                .map((record) => record.fields as Record<string, unknown>)
                .filter((fields) => fields.provider === 'codex')
                .map((fields) => `${String(fields.from)}->${String(fields.to)}`);
            expect(healthTransitions).toContain('notInstalled->installedPending');
            expect(healthTransitions).toContain('installedPending->active');
            expect(healthTransitions.at(-1)).toBe('active->notInstalled');
            const activeFields = logRecords.find(
                (record) =>
                    record.event === 'agent_hooks.health_changed' &&
                    (record.fields as Record<string, unknown>).to === 'active',
            )?.fields as Record<string, unknown> | undefined;
            expect(activeFields?.installedSchema).toBe(codexHookAdapter.schemaVersion);
            expect(activeFields?.profileId).toMatch(/^[a-f\d]{16}$/u);

            const metricNames = logger
                .metricSnapshot()
                .series.map((series) => series.name)
                .filter((name) => name.startsWith('hook.'));
            expect(metricNames).toContain('hook.signal');
            expect(metricNames).toContain('hook.latency');
        } finally {
            await manager.close();
        }
    });

    it('reports a launch that never received a signal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-silent-launch-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const logger = new StructuredLogger(join(directory, 'logs'), 'server-core', 'info');
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            manager.terminalEnvironment('terminal-silent', 'codex');
            manager.endTerminalLaunch('terminal-silent');
            await logger.flush();

            const summary = (await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>)
                .find((record) => record.event === 'agent_hooks.launch_summary');

            /**
             * The loudest record this class emits: hooks were installed and handed to the PTY, and nothing came back.
             */
            expect(summary).toMatchObject({
                fields: {
                    accepted: 0,
                    ignored: 0,
                    rejected: 0,
                    signals: 0,
                    terminalId: 'terminal-silent',
                },
            });
            expect(summary?.fields).not.toHaveProperty('firstSignalMs');
        } finally {
            await manager.close();
        }
    });

    it('records a repair that cannot converge once and never rewrites an unchanged config', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-convergence-'));
        temporaryDirectories.push(directory);
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.claude.hooks.enabled = true;
        settings.codex.hooks.enabled = false;
        settings.grok.hooks.enabled = false;
        await mkdir(join(directory, '.claude'), { recursive: true });
        await writeFile(join(directory, '.claude', 'settings.json'), '{ "hooks": {} }\n');
        /**
         * An edit plan that returns the document unchanged models an adapter whose render and inspect disagree: the
         * status stays `absent` however often it runs.
         */
        vi.spyOn(claudeHookAdapter, 'render').mockImplementation((documents) => [
            { targetId: 'settings', source: documents.get('settings')! },
        ]);
        const logger = new StructuredLogger(join(directory, 'logs'), 'server-core', 'info');
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: {} },
            logger,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            await manager.reconcile(settings);
            await manager.reconcile(settings);
            await logger.flush();

            const records = (await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { event: string; fields?: unknown });
            expect(
                records.filter((record) => record.event === 'agent_hooks.config_written'),
            ).toEqual([]);
            expect(
                records.filter((record) => record.event === 'agent_hooks.repair_not_converged'),
            ).toEqual([
                expect.objectContaining({
                    fields: {
                        stage: 'serverCore',
                        provider: 'claude',
                        action: 'install',
                        fromStatus: 'absent',
                        toStatus: 'absent',
                        written: 0,
                    },
                }),
            ]);
        } finally {
            await manager.close();
        }
    });
});
