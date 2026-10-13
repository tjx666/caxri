import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { AgentHookManager } from '../manager';
import { hookBridgeEnvironment } from './server.fixture';

describe('Agent hook turn context', () => {
    it('prints the context of an accepted turnStarted signal as UserPromptSubmit context', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-context-'));
        const userDataPath = join(directory, 'profile');
        await mkdir(userDataPath);
        const logger = new StructuredLogger(join(directory, 'logs'));
        const turnContext = vi.fn((signal: { phase: string }) =>
            signal.phase === 'turnStarted' ? 'Use "$CAXRI_CLI" for Sessions.' : undefined,
        );
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: join(directory, 'codex') },
            },
            userDataPath,
            sharedPath: join(directory, 'shared'),
            logger,
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: () => 'accepted',
            turnContext,
            send: vi.fn(),
        });
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        settings.claude.hooks.enabled = false;
        settings.grok.hooks.enabled = false;
        const hook = (phase: string) =>
            execFileAsync(
                join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge'),
                ['--source', 'caxri', '--provider', 'codex', '--phase', phase],
                { env: hookBridgeEnvironment(manager.shellEnvironment('terminal')) },
            );
        try {
            await manager.initialize(settings);

            const started = await hook('turnStarted');
            expect(JSON.parse(started.stdout)).toEqual({
                hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: 'Use "$CAXRI_CLI" for Sessions.',
                },
            });
            expect((await hook('turnFinished')).stdout).toBe('');
            expect(turnContext).toHaveBeenCalledTimes(2);
        } finally {
            await manager.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
