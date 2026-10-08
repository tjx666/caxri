import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { AgentHookManager } from '../manager';
import { hookBridgeEnvironment } from './server.fixture';

async function fileIdentity(path: string) {
    try {
        const [source, metadata] = await Promise.all([
            readFile(path),
            stat(path, { bigint: true }),
        ]);
        return { hash: createHash('sha256').update(source).digest('hex'), mtime: metadata.mtimeNs };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
}

describe('Agent hook profile write authority', () => {
    it('keeps managed launches fail-closed while executable validation is pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-gate-'));
        const userDataPath = join(directory, 'profile');
        await mkdir(userDataPath);
        const logger = new StructuredLogger(join(directory, 'logs'));
        let pendingDiscovery: PromiseWithResolvers<string | undefined> | undefined;
        const signals = vi.fn(() => 'accepted' as const);
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: join(directory, 'codex') },
            },
            userDataPath,
            sharedPath: join(directory, 'shared'),
            logger,
            discoverExecutable: () =>
                pendingDiscovery?.promise ?? Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: signals,
            send: vi.fn(),
        });
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        settings.claude.hooks.enabled = false;
        settings.grok.hooks.enabled = false;
        try {
            await manager.initialize(settings);
            expect(manager.terminalEnvironment('terminal', 'codex')).toHaveProperty(
                'CAXRI_HOOK_TOKEN',
            );
            const existingShellEnvironment = manager.shellEnvironment('existing-shell');

            pendingDiscovery = Promise.withResolvers<string | undefined>();
            const reconciling = manager.reconcile(structuredClone(settings));
            expect(manager.terminalEnvironment('terminal', 'codex')).toEqual({});
            await execFileAsync(
                join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge'),
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnFinished'],
                { env: hookBridgeEnvironment(existingShellEnvironment) },
            );
            await vi.waitFor(() => expect(signals).toHaveBeenCalledOnce());

            pendingDiscovery.resolve(process.execPath);
            await reconciling;
            expect(manager.terminalEnvironment('terminal', 'codex')).toHaveProperty(
                'CAXRI_HOOK_TOKEN',
            );
        } finally {
            pendingDiscovery?.resolve(process.execPath);
            await manager.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('ignores a disabled provider signal across the whole re-check window', async () => {
        /**
         * A config-file watcher re-runs reconciliation with the same requested settings, which still say "enabled" for
         * a provider whose CLI Caxri could not resolve. Discovery that re-decides it is asynchronous, so the window
         * between re-publishing that intent and gating it again must never accept a signal for the disabled provider
         * (issue #720). The token is real and the launch is live; only the effective authority says no.
         */
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-recheck-'));
        const userDataPath = join(directory, 'profile');
        await mkdir(userDataPath);
        const logger = new StructuredLogger(join(directory, 'logs'));
        let codexDiscovery: PromiseWithResolvers<string | undefined> | undefined;
        let isCodexInstalled = false;
        const accepted: string[] = [];
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: join(directory, 'codex') },
            },
            userDataPath,
            sharedPath: join(directory, 'shared'),
            logger,
            discoverExecutable: (provider) =>
                provider === 'codex'
                    ? (codexDiscovery?.promise ??
                      Promise.resolve(isCodexInstalled ? process.execPath : undefined))
                    : Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: (signal) => {
                accepted.push(signal.provider);
                return 'accepted';
            },
            send: vi.fn(),
        });
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.claude.hooks.enabled = true;
        settings.codex.hooks.enabled = true;
        settings.grok.hooks.enabled = false;
        const signal = (shellEnvironment: NodeJS.ProcessEnv, provider: string) =>
            execFileAsync(
                join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge'),
                ['--source', 'caxri', '--provider', provider, '--phase', 'turnFinished'],
                { env: hookBridgeEnvironment(shellEnvironment) },
            );
        try {
            await manager.initialize(settings);
            expect(manager.getHealth().codex.kind).toBe('notInstalled');
            const shell = manager.shellEnvironment('shell');

            await signal(shell, 'codex');
            expect(accepted).toEqual([]);

            codexDiscovery = Promise.withResolvers<string | undefined>();
            const reconciling = manager.reconcile(structuredClone(settings));
            await signal(shell, 'codex');
            expect(accepted).toEqual([]);
            // The other provider keeps its authority throughout: this is a per-provider gate, not a global freeze.
            await signal(shell, 'claude');
            expect(accepted).toEqual(['claude']);

            // Discovery still fails, so the provider stays closed rather than inheriting the re-published intent.
            codexDiscovery.resolve(undefined);
            await reconciling;
            await signal(shell, 'codex');
            expect(accepted).toEqual(['claude']);

            isCodexInstalled = true;
            codexDiscovery = undefined;
            await manager.reconcile(structuredClone(settings));
            await signal(manager.shellEnvironment('shell'), 'codex');
            expect(accepted).toEqual(['claude', 'codex']);
        } finally {
            codexDiscovery?.resolve(undefined);
            await manager.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('preserves a temporarily unavailable profile intent until explicit disable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-intent-'));
        const userDataPath = join(directory, 'profile');
        await mkdir(userDataPath);
        const config = join(directory, 'codex');
        const sharedPath = join(directory, 'shared');
        const logger = new StructuredLogger(join(directory, 'logs'));
        let isAvailable = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: config } },
            userDataPath,
            sharedPath,
            logger,
            discoverExecutable: () => Promise.resolve(isAvailable ? process.execPath : undefined),
            hookExecutable: process.execPath,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: () => 'accepted',
            send: vi.fn(),
        });
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        settings.claude.hooks.enabled = false;
        settings.grok.hooks.enabled = false;
        try {
            await manager.initialize(settings);
            const hooks = join(config, 'hooks.json');
            const before = await fileIdentity(hooks);
            isAvailable = false;
            await manager.reconcile(structuredClone(settings));
            expect(await fileIdentity(hooks)).toEqual(before);
            const registry = JSON.parse(
                await readFile(join(sharedPath, 'profile-intents.json'), 'utf8'),
            ) as {
                profiles: Record<string, { providers: string[] }>;
            };
            expect(
                Object.values(registry.profiles).flatMap((profile) => profile.providers),
            ).toEqual(['codex']);
            expect(manager.getHealth().codex.kind).toBe('notInstalled');
            settings.codex.hooks.enabled = false;
            await manager.reconcile(settings);
            expect(JSON.parse(await readFile(hooks, 'utf8'))).not.toHaveProperty('hooks');
        } finally {
            await manager.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it.each(
        (['disabled', 'missing-cli'] as const).flatMap((mode) =>
            (['absent', 'stale', 'drifted'] as const).map((damage) => ({ mode, damage })),
        ),
    )(
        'does not repair $damage config claimed by another profile when locally $mode',
        async ({ mode, damage }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-write-authority-'));
            const config = join(directory, 'codex');
            const hooks = join(config, 'hooks.json');
            const createManager = async (name: string, isAvailable: boolean) => {
                const userDataPath = join(directory, name);
                await mkdir(userDataPath);
                const logger = new StructuredLogger(join(userDataPath, 'logs'));
                const manager = new AgentHookManager({
                    environment: { homeDirectory: directory, variables: { CODEX_HOME: config } },
                    userDataPath,
                    sharedPath: join(directory, 'shared'),
                    logger,
                    discoverExecutable: () =>
                        Promise.resolve(isAvailable ? process.execPath : undefined),
                    hookExecutable: process.execPath,
                    onAuthorityLost: vi.fn(),
                    onLaunchEnded: vi.fn(),
                    onLaunchStarted: vi.fn(),
                    onSignal: () => 'accepted',
                    send: vi.fn(),
                });
                return { manager, logger };
            };
            const owner = await createManager('owner', true);
            const current = await createManager('current', mode === 'disabled');
            const enabled = structuredClone(defaultAgentProviderSettings);
            enabled.codex.hooks.enabled = true;
            enabled.claude.hooks.enabled = false;
            enabled.grok.hooks.enabled = false;
            try {
                await owner.manager.initialize(enabled);
                await owner.manager.close();
                const installed = await readFile(hooks, 'utf8');
                if (damage === 'absent') await rm(hooks);
                else if (damage === 'stale')
                    await writeFile(hooks, installed.replaceAll(/--schema\s+\d+/gu, '--schema 0'));
                else {
                    const source = JSON.parse(installed) as { hooks: Record<string, unknown> };
                    delete source.hooks.Stop;
                    await writeFile(hooks, JSON.stringify(source));
                }
                const before = await fileIdentity(hooks);
                const requested = structuredClone(enabled);
                requested.codex.hooks.enabled = mode === 'missing-cli';
                await current.manager.initialize(requested);
                expect(await fileIdentity(hooks)).toEqual(before);
                expect(current.manager.getHealth().codex.kind).toBe('notInstalled');
            } finally {
                await Promise.all([owner.manager.close(), current.manager.close()]);
                await Promise.all([owner.logger.flush(), current.logger.flush()]);
                await rm(directory, { recursive: true, force: true });
            }
        },
    );
});
