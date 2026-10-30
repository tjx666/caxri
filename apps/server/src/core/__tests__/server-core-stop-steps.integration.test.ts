import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import type { DomainHandlers, DomainServices } from '../../domains/domain-services';
import * as extensionServiceFactory from '../extensions/create-service';
import type { ServerCore } from '../server-core';
import { startServerCore } from '../server-core';
import { serverCoreStopFailureCapsule } from '../server-core-stop-steps';
import { createMemoryCredentialStores } from './credential-stores.fixture';

interface LogLine {
    event: string;
    durationMs?: number;
    fields?: Record<string, unknown>;
    failure?: Record<string, unknown>;
}

const stopEvents = new Set([
    'server_core.stopping',
    'server_core.stop_failed',
    'server_core.stopped',
]);
const directories: string[] = [];

/**
 * A failed stop cannot be retried (`stop()` returns the same rejected promise), so only the profile folder is cleaned.
 */
afterEach(async () => {
    vi.restoreAllMocks();
    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function startWith(
    close: DomainServices['close'],
    extensionShutdown: () => Promise<void> = () => Promise.resolve(),
): Promise<{ app: ServerCore; userDataPath: string }> {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-stop-steps-'));
    directories.push(userDataPath);
    vi.spyOn(extensionServiceFactory, 'createExtensionService').mockResolvedValue({
        activeContextChanged: vi.fn(),
        markCoreStopping: vi.fn(),
        shutdown: vi.fn(extensionShutdown),
    } as never);
    const app = await startServerCore({
        commit: 'test',
        createDomainServices: () =>
            Promise.resolve({
                close,
                handlers: {} as DomainHandlers,
                credentials: createMemoryCredentialStores(),
                protocolRecovery: createTestProtocolRecoveryState(),
                validateRequestContext: () => {},
            }),
        userDataPath,
        version: '1.0.0',
    });
    return { app, userDataPath };
}

async function stopRecords(userDataPath: string, until: string): Promise<LogLine[]> {
    let lines: LogLine[] = [];
    await vi.waitFor(async () => {
        const log = await readFile(join(userDataPath, 'logs', 'server-core.jsonl'), 'utf8');
        lines = log
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogLine);
        expect(lines.some((line) => line.event === until)).toBe(true);
    });
    return lines.filter((line) => stopEvents.has(line.event));
}

describe('Server Core stop steps', () => {
    it('logs one stop_failed naming the domain services step, and no stopped record', async () => {
        const { app, userDataPath } = await startWith(() =>
            Promise.reject(new Error('domain close failed')),
        );

        await expect(app.stop('SIGTERM')).rejects.toThrow('domain close failed');

        const records = await stopRecords(userDataPath, 'server_core.stop_failed');
        expect(records.map((record) => record.event)).toEqual([
            'server_core.stopping',
            'server_core.stop_failed',
        ]);
        const failed = records[1];
        expect(failed.fields).toEqual({
            reason: 'SIGTERM',
            step: 'domainServices',
            message: 'domain close failed',
        });
        expect(failed.durationMs).toBeGreaterThanOrEqual(0);
        expect(failed.failure).toMatchObject({
            owner: 'server-core',
            phase: 'shutdown',
            remediation: 'restart-core',
        });
    });

    it('names the Terminal snapshot pass once when it fails inside the domain services', async () => {
        const { app, userDataPath } = await startWith(async (runStep) => {
            await runStep?.('terminals', () => Promise.reject(new Error('snapshot failed')));
        });

        await expect(app.stop('SIGTERM')).rejects.toThrow('snapshot failed');

        const records = await stopRecords(userDataPath, 'server_core.stop_failed');
        const failures = records.filter((record) => record.event === 'server_core.stop_failed');
        expect(failures).toHaveLength(1);
        expect(failures[0].fields).toMatchObject({ step: 'terminals' });
    });

    it('names a Core-level step that fails after the domain services closed', async () => {
        const { app, userDataPath } = await startWith(
            () => Promise.resolve(),
            () => Promise.reject(new Error('extension host failed')),
        );

        await expect(app.stop('SIGTERM')).rejects.toThrow('extension host failed');

        const records = await stopRecords(userDataPath, 'server_core.stop_failed');
        expect(records.at(-1)?.fields).toMatchObject({ step: 'extensionHost' });
        expect(records.some((record) => record.event === 'server_core.stopped')).toBe(false);
    });

    it('records the total and per-step durations of a clean stop', async () => {
        const { app, userDataPath } = await startWith(async (runStep) => {
            await runStep?.('terminals', () => Promise.resolve());
        });

        await app.stop('SIGTERM');

        const records = await stopRecords(userDataPath, 'server_core.stopped');
        const stopped = records.find((record) => record.event === 'server_core.stopped')!;
        const steps = Object.entries(stopped.fields ?? {}).filter(([key]) => key.endsWith('Ms'));
        expect(
            steps.map(([key]) => key).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([
            'agentInboxMs',
            'controlServerMs',
            'domainServicesMs',
            'extensionHostMs',
            'leaseMs',
            'mobileAccessMs',
            'providerMessagingMs',
            'terminalsMs',
        ]);
        for (const [, value] of steps) expect(value).toBeTypeOf('number');
        for (const [, value] of steps) expect(value as number).toBeGreaterThanOrEqual(0);
        // `terminals` runs inside `domainServices`, and each value is rounded on its own.
        const outerSum = steps
            .filter(([key]) => key !== 'terminalsMs')
            .reduce((sum, [, value]) => sum + (value as number), 0);
        expect(outerSum).toBeLessThanOrEqual(stopped.durationMs! + steps.length);
    });
});

describe('Server Core stop settling', () => {
    async function readEvents(userDataPath: string): Promise<string[]> {
        const log = await readFile(join(userDataPath, 'logs', 'server-core.jsonl'), 'utf8');
        return log
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as LogLine).event);
    }

    // A caller that removes the profile once `stop()` settles (a test teardown, an embedding host) must not race a
    // record still draining into `logs/`: the append recreates the file and the removal fails with ENOTEMPTY.
    it('has written its stopped record to disk by the time a clean stop resolves', async () => {
        const { app, userDataPath } = await startWith(() => Promise.resolve());

        await app.stop('SIGTERM');

        expect(await readEvents(userDataPath)).toContain('server_core.stopped');
    });

    it('has written every stop record to disk by the time a failed stop rejects', async () => {
        const { app, userDataPath } = await startWith(() =>
            Promise.reject(new Error('domain close failed')),
        );

        await expect(app.stop('SIGTERM')).rejects.toThrow('domain close failed');

        expect(await readEvents(userDataPath)).toEqual(
            expect.arrayContaining(['server_core.stopping', 'server_core.stop_failed']),
        );
    });
});

describe('Server Core best-effort stop', () => {
    it('runs the Extension Host shutdown and lease release after domain services fail, then rejects', async () => {
        const extensionShutdown = vi.fn(() => Promise.resolve());
        const { app, userDataPath } = await startWith(
            () => Promise.reject(new Error('domain close failed')),
            extensionShutdown,
        );
        const release = vi.spyOn(app.lease, 'release');

        await expect(app.stop('command')).rejects.toThrow('domain close failed');

        expect(extensionShutdown).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        const records = await stopRecords(userDataPath, 'server_core.stop_failed');
        expect(records.filter((record) => record.event === 'server_core.stop_failed')).toHaveLength(
            1,
        );
    });

    it('logs each failing top-level step once and still releases the lease', async () => {
        const { app, userDataPath } = await startWith(
            () => Promise.reject(new Error('domain close failed')),
            () => Promise.reject(new Error('extension host failed')),
        );
        const release = vi.spyOn(app.lease, 'release');

        await expect(app.stop('command')).rejects.toThrow();

        const records = await stopRecords(userDataPath, 'server_core.stop_failed');
        expect(
            records
                .filter((record) => record.event === 'server_core.stop_failed')
                .map((record) => record.fields?.step),
        ).toEqual(['domainServices', 'extensionHost']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('settles stopped on the host.stop style path where the stop rejection is swallowed', async () => {
        const { app } = await startWith(() => Promise.reject(new Error('domain close failed')));

        // host.stop and idle exit swallow the stop() rejection; the process entrypoint awaits `stopped` instead.
        // eslint-disable-next-line unicorn/prefer-await -- mirrors the fire-and-forget host.stop caller
        app.stop('command').catch(() => {});

        await expect(app.stopped).rejects.toThrow('domain close failed');
    });
});

describe('serverCoreStopFailureCapsule', () => {
    it('classifies a failed stop as a Server Core shutdown fault', () => {
        expect(serverCoreStopFailureCapsule()).toMatchObject({
            owner: 'server-core',
            phase: 'shutdown',
            reason: 'unknown',
            remediation: 'restart-core',
            retryable: false,
            schemaVersion: 1,
        });
    });
});
