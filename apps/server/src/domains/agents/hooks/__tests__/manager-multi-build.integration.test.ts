import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexHookAdapter } from '../../providers/codex/hooks';
import type { AgentLifecycleSignal, AgentSignalDecision } from '../contract';
import { AgentHookManager } from '../manager';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Issue #557: a packaged release and a worktree dev instance share one global provider hook file and one staged bridge.
 * The file must converge instead of being rewritten back and forth, and each build must keep accepting its own
 * Terminal's signals regardless of which build's entries won the file.
 */
describe('AgentHookManager across concurrently running Caxri builds', () => {
    it('lets two Caxri builds with different schema versions share one provider file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-multi-build-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const sharedPath = join(directory, 'shared');
        const releaseProfile = join(directory, 'profile-release');
        const developmentProfile = join(directory, 'profile-dev');
        await Promise.all([
            mkdir(releaseProfile, { recursive: true }),
            mkdir(developmentProfile, { recursive: true }),
        ]);
        const hooksPath = join(codexHome, 'hooks.json');
        const render = vi.spyOn(codexHookAdapter, 'render');
        /**
         * A packaged release and a worktree dev instance run side by side with different hook schema versions. Both
         * write the same global provider file: the file converges on the newer build's entries, and the schema each
         * instance validates against travels only in its own Terminal launch environment, so the superseded build keeps
         * accepting its own signals instead of rewriting the file back.
         */
        const createBuild = (userDataPath: string, schemaVersion: number) => {
            const signals = vi.fn<(signal: AgentLifecycleSignal) => AgentSignalDecision>(
                () => 'accepted',
            );
            const authorityLost = vi.fn();
            const manager = new AgentHookManager({
                environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
                logger: new StructuredLogger(join(userDataPath, 'logs')),
                onAuthorityLost: authorityLost,
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: signals,
                discoverExecutable: () => Promise.resolve(process.execPath),
                hookExecutable: process.execPath,
                schemaVersions: { codex: schemaVersion },
                send: vi.fn(),
                sharedPath,
                userDataPath,
            });
            return { authorityLost, manager, signals };
        };
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const release = createBuild(releaseProfile, 8);
        const development = createBuild(developmentProfile, 9);

        try {
            await release.manager.initialize(structuredClone(settings));
            expect(await readFile(hooksPath, 'utf8')).toContain('--schema 8');

            // The newer build repairs the older entries exactly once; the older build then leaves them alone.
            await development.manager.initialize(structuredClone(settings));
            const converged = await readFile(hooksPath, 'utf8');
            expect(converged).toContain('--schema 9');
            expect(converged).not.toContain('--schema 8');
            await release.manager.reconcile(structuredClone(settings));
            await development.manager.reconcile(structuredClone(settings));
            expect(await readFile(hooksPath, 'utf8')).toBe(converged);
            expect(render).toHaveBeenCalledTimes(2);
            expect(release.manager.getHealth().codex.kind).toBe('installedPending');
            expect(development.manager.getHealth().codex.kind).toBe('installedPending');

            const bridge = join(sharedPath, 'bin', 'caxri-agent-hook-bridge');
            for (const build of [release, development]) {
                const environment = build.manager.terminalEnvironment('terminal-1', 'codex');
                // eslint-disable-next-line no-await-in-loop -- each build's launch is exercised in turn
                const result = await execFileAsync(
                    bridge,
                    ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnFinished'],
                    { env: { ...process.env, ...environment } },
                );
                expect(result.stderr).toBe('');
            }
            expect(release.signals).toHaveBeenCalledTimes(1);
            expect(release.signals.mock.calls[0][0]).toMatchObject({ schemaVersion: 8 });
            expect(development.signals).toHaveBeenCalledTimes(1);
            expect(development.signals.mock.calls[0][0]).toMatchObject({ schemaVersion: 9 });

            // Being superseded must not cost the older build its hook authority on a later reconcile.
            expect(release.manager.getHealth().codex.kind).toBe('active');
            await release.manager.reconcile(structuredClone(settings));
            expect(release.authorityLost).not.toHaveBeenCalled();
            expect(release.manager.getHealth().codex.kind).toBe('active');
        } finally {
            await Promise.all([release.manager.close(), development.manager.close()]);
        }
    });
});
