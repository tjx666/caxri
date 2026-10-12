import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigDocumentsModule from '../config-documents';
import { AgentHookManager } from '../manager';

/**
 * Holds a reconcile at its first provider config read, so a launch can be prepared while that reconcile is in flight.
 * `release` also runs after a failed assertion, so `close()` never waits on a held reconcile forever.
 */
const configReads = vi.hoisted(() => ({
    before: undefined as (() => Promise<void>) | undefined,
    release: () => {},
}));

vi.mock('../config-documents', async (importOriginal) => {
    const actual = await importOriginal<typeof ConfigDocumentsModule>();
    const readConfigDocuments: typeof actual.readConfigDocuments = async (targets, maxBytes) => {
        await configReads.before?.();
        return actual.readConfigDocuments(targets, maxBytes);
    };
    return { ...actual, readConfigDocuments };
});

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    configReads.before = undefined;
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Watcher-driven reconciliation has no completion signal, and native event latency is unbounded on a loaded host.
 */
const WATCHER_WAIT = { interval: 50, timeout: 10_000 } as const;

async function claudeAndGrokManager() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-config-reconcile-'));
    temporaryDirectories.push(directory);
    const claudeHome = join(directory, 'claude');
    await mkdir(claudeHome, { recursive: true });
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core', 'info');
    loggers.push(logger);
    const manager = new AgentHookManager({
        environment: {
            homeDirectory: directory,
            variables: { CLAUDE_CONFIG_DIR: claudeHome, GROK_HOME: join(directory, 'grok') },
        },
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
    const settings = structuredClone(defaultAgentProviderSettings);
    settings.claude.hooks.enabled = true;
    settings.codex.hooks.enabled = false;
    settings.grok.hooks.enabled = true;
    return { claudeSettings: join(claudeHome, 'settings.json'), manager, settings };
}

/**
 * Blocks every later config read until `release`; `held` reports whether a reconcile reached one.
 */
function holdConfigReads() {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const state = { held: false };
    configReads.before = async () => {
        state.held = true;
        await gate;
    };
    configReads.release = release;
    return { release, state };
}

/**
 * A Claude or Grok launch prepared while hooks reconcile after a provider config edit must still get the hook
 * environment: the edit leaves the requested settings unchanged, so the last gated launch view stays valid.
 */
describe('AgentHookManager launches during a reconcile', () => {
    it('keeps the hook environment while a config edit is reconciled', async () => {
        const { claudeSettings, manager, settings } = await claudeAndGrokManager();
        try {
            await manager.initialize(settings);
            expect(manager.getHealth().grok.kind).toBe('installedPending');
            const { release, state } = holdConfigReads();

            await writeFile(claudeSettings, '{ "theme": "dark" }\n', 'utf8');
            await vi.waitFor(() => expect(state.held).toBe(true), WATCHER_WAIT);

            expect(manager.terminalEnvironment('terminal-claude', 'claude')).toHaveProperty(
                'CAXRI_HOOK_TOKEN',
            );
            expect(manager.terminalEnvironment('terminal-grok', 'grok')).toHaveProperty(
                'CAXRI_HOOK_TOKEN',
            );
            release();
        } finally {
            configReads.before = undefined;
            configReads.release();
            await manager.close();
        }
    });

    it('withholds the hook environment while changed settings are reconciled', async () => {
        const { manager, settings } = await claudeAndGrokManager();
        try {
            await manager.initialize(settings);
            const { release, state } = holdConfigReads();

            const reconcile = manager.reconcile(structuredClone(settings));
            await vi.waitFor(() => expect(state.held).toBe(true));

            expect(manager.terminalEnvironment('terminal-claude', 'claude')).toEqual({});
            expect(() => manager.terminalEnvironment('terminal-grok', 'grok')).toThrow(
                'requires installed lifecycle hooks for reliable Session identity',
            );
            release();
            await reconcile;
            expect(manager.terminalEnvironment('terminal-claude', 'claude')).toHaveProperty(
                'CAXRI_HOOK_TOKEN',
            );
        } finally {
            configReads.before = undefined;
            configReads.release();
            await manager.close();
        }
    });
});
