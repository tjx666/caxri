import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    ObservationProcessOwner,
    ObservationProcessProbeState,
    ObservationProcessState,
} from '@caxri/system';
import {
    BoundedMetricRegistry,
    observationProcessManifestDirectory,
    ObservationProcessManifestPublisher,
} from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { parseUserDataDirectory, readProcessManifests } from '../read-process-manifests';

const LIVE_PID = 4101;
const DEAD_PID = 4102;
const processState = (pid: number): ObservationProcessProbeState =>
    pid === DEAD_PID ? 'dead' : 'alive';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function userData(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-process-manifests-'));
    directories.push(directory);
    return directory;
}

/**
 * Writes a manifest the way the process itself does, through the production publisher.
 */
async function publish(
    root: string,
    owner: ObservationProcessOwner,
    state: ObservationProcessState,
    pid: number,
): Promise<void> {
    const publisher = new ObservationProcessManifestPublisher({
        directory: observationProcessManifestDirectory(root),
        owner,
        pid,
        startedAt: Date.UTC(2026, 9, 28, 1),
        now: () => new Date(Date.UTC(2026, 9, 28, 2)),
    });
    const metrics = new BoundedMetricRegistry();
    metrics.record('process.open_fds', 42, { owner });
    publisher.publish(state, { metrics: metrics.snapshot() });
    await publisher.flush();
}

describe('read-process-manifests', () => {
    it('reports all three processes, which pids are alive, and no fault when they stopped cleanly', async () => {
        const root = await userData();
        await publish(root, 'server-core', 'stopped', DEAD_PID);
        await publish(root, 'terminal-host', 'ready', LIVE_PID);
        await publish(root, 'extension-host', 'ready', LIVE_PID);

        const report = await readProcessManifests(root, processState);

        expect(report.missing).toEqual([]);
        expect(report.unreadable).toEqual({});
        expect(report.owners['server-core']).toMatchObject({
            state: 'stopped',
            pid: DEAD_PID,
            pidAlive: false,
            startedAt: '2026-10-28T01:00:00.000Z',
            updatedAt: '2026-10-28T02:00:00.000Z',
        });
        expect(report.owners['terminal-host']).toMatchObject({ state: 'ready', pidAlive: true });
        expect(report.diagnosis.classification).toBe('unknown');
    });

    it('names the owner whose manifest still reads ready after its process died', async () => {
        const root = await userData();
        await publish(root, 'server-core', 'ready', LIVE_PID);
        await publish(root, 'terminal-host', 'ready', DEAD_PID);

        const report = await readProcessManifests(root, processState);

        expect(report.owners['terminal-host']?.pidAlive).toBe(false);
        expect(report.missing).toEqual(['extension-host']);
        expect(report.diagnosis.classification).toBe('terminal-host');
        expect(report.diagnosis.chain[0]).toMatchObject({ reason: 'terminal-host-exited' });
    });

    it('lists missing and refused manifests instead of failing, and writes nothing', async () => {
        const root = await userData();
        const directory = observationProcessManifestDirectory(root);
        await publish(root, 'server-core', 'ready', LIVE_PID);
        await writeFile(join(directory, 'terminal-host.json'), '{not json', { mode: 0o600 });
        await writeFile(join(directory, 'extension-host.json'), '{}', { mode: 0o644 });
        await chmod(join(directory, 'extension-host.json'), 0o644);
        const before = await readdir(directory);

        const report = await readProcessManifests(root, processState);

        expect(report.unreadable).toEqual({
            'terminal-host': 'Observation process manifest is malformed',
            'extension-host': 'Observation process manifest must be a bounded private regular file',
        });
        expect(Object.keys(report.owners)).toEqual(['server-core']);
        expect(await readdir(directory)).toEqual(before);

        const empty = await userData();
        expect(await readProcessManifests(empty, processState)).toMatchObject({
            owners: {},
            missing: ['server-core', 'terminal-host', 'extension-host'],
        });
    });

    it('prints only manifest fields, never the userData path', async () => {
        const root = await userData();
        await mkdir(observationProcessManifestDirectory(root), { recursive: true, mode: 0o700 });
        await publish(root, 'server-core', 'failed', LIVE_PID);

        const report = await readProcessManifests(root, processState);

        expect(
            Object.keys(report.owners['server-core'] ?? {}).toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual([
            'context',
            'failure',
            'metrics',
            'pid',
            'pidAlive',
            'startedAt',
            'state',
            'updatedAt',
        ]);
        expect(report.diagnosis.classification).toBe('server-core');
        expect(JSON.stringify(report)).not.toContain(root);
    });

    it('requires an absolute userData path', () => {
        expect(parseUserDataDirectory(['--user-data-dir', '/tmp/caxri'])).toBe('/tmp/caxri');
        expect(() => parseUserDataDirectory(['--user-data-dir', 'relative'])).toThrow('Usage');
        expect(() => parseUserDataDirectory([])).toThrow('Usage');
    });
});
