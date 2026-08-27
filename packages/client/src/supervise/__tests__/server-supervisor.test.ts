import type { ServerManifest } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerClient } from '../client';
import type { ServerArtifactSupervisorAdapter, ServerSupervisionEvent } from '../server-supervisor';
import { ServerArtifactSupervisor } from '../server-supervisor';

function manifest(pid: number, startedAt = pid): ServerManifest {
    return {
        endpoint: {
            protocol: 'ws',
            host: '127.0.0.1',
            port: 41_337,
            path: '/control',
        },
        manifestVersion: 2,
        operatorToken: 'a'.repeat(64),
        pid,
        processIdentity: pid.toString(16).padStart(32, '0'),
        profileId: 'profile-1',
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        startedAt,
        version: '1.0.0',
    };
}

function fixture() {
    let clock = 0;
    let currentManifest: ServerManifest | undefined;
    let nextPid = 100;
    const alive = new Set<number>();
    const launchedPids: number[] = [];
    const client = { close: vi.fn() } as unknown as ServerClient;
    const connect = vi.fn(() => Promise.resolve(client));
    const launch = vi.fn(() => {
        nextPid += 1;
        launchedPids.push(nextPid);
        currentManifest = manifest(nextPid, clock + 1);
        alive.add(nextPid);
        return Promise.resolve({ pid: nextPid });
    });
    const adapter: ServerArtifactSupervisorAdapter = {
        connect,
        discover: vi.fn(() =>
            currentManifest
                ? Promise.resolve(currentManifest)
                : Promise.reject(new CaxriError('NOT_FOUND', 'missing')),
        ),
        isProcessAlive: (pid) => alive.has(pid),
        launch,
        now: () => clock,
        wait: (milliseconds) => {
            clock += milliseconds;
            return Promise.resolve();
        },
    };
    return {
        adapter,
        advance(milliseconds: number) {
            clock += milliseconds;
        },
        alive,
        clearManifest() {
            currentManifest = undefined;
        },
        client,
        connect,
        launch,
        launchedPids,
        setManifest(value: ServerManifest | undefined) {
            currentManifest = value;
        },
    };
}

describe('ServerArtifactSupervisor', () => {
    it('adopts a ready process without launching another contender', async () => {
        const state = fixture();
        const existing = manifest(42);
        state.setManifest(existing);
        state.alive.add(existing.pid);
        const supervisor = new ServerArtifactSupervisor(
            '/profile',
            { artifactRoot: '/server' },
            { adapter: state.adapter },
        );

        await expect(supervisor.ensure()).resolves.toBe(state.client);

        expect(state.connect).toHaveBeenCalledWith(existing, 2_000);
        expect(state.launch).not.toHaveBeenCalled();
    });

    it('restarts a crash loop three times with capped exponential backoff, then fails', async () => {
        const state = fixture();
        state.launch.mockImplementation(() => Promise.resolve({ pid: 101 }));
        const supervisor = new ServerArtifactSupervisor(
            '/profile',
            { artifactRoot: '/server' },
            { adapter: state.adapter },
        );
        const lifecycle: ServerSupervisionEvent[] = [];
        supervisor.onLifecycle((event) => lifecycle.push(event));

        await expect(supervisor.ensure(10_000)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Runtime failed after 3 restart attempts',
        });

        expect(state.launch).toHaveBeenCalledTimes(4);
        expect(lifecycle.slice(0, 3)).toEqual([
            { backoffMs: 250, restartCount: 1, status: 'restarting' },
            { backoffMs: 500, restartCount: 2, status: 'restarting' },
            { backoffMs: 1_000, restartCount: 3, status: 'restarting' },
        ]);
        expect(lifecycle[3]).toMatchObject({
            error: { code: 'UNAVAILABLE' },
            restartCount: 3,
            status: 'failed',
        });
    });

    it('resets the restart budget only after the ready process passes the stability window', async () => {
        const state = fixture();
        const first = manifest(42);
        state.setManifest(first);
        state.alive.add(first.pid);
        const supervisor = new ServerArtifactSupervisor(
            '/profile',
            { artifactRoot: '/server' },
            { adapter: state.adapter },
        );
        const lifecycle: ServerSupervisionEvent[] = [];
        supervisor.onLifecycle((event) => lifecycle.push(event));
        await supervisor.ensure();

        state.alive.delete(first.pid);
        state.clearManifest();
        expect(supervisor.reportProcessLoss(first.pid)).toBe(true);
        await supervisor.ensure();
        const secondPid = state.launchedPids[0] ?? -1;
        expect(secondPid).toBe(101);

        state.advance(30_000);
        state.alive.delete(secondPid);
        state.clearManifest();
        expect(supervisor.reportProcessLoss(secondPid)).toBe(true);

        expect(lifecycle).toEqual([
            { backoffMs: 250, restartCount: 1, status: 'restarting' },
            { backoffMs: 250, restartCount: 1, status: 'restarting' },
        ]);
    });

    it('does not consume crash budget for an intentional stale-build replacement', async () => {
        const state = fixture();
        const existing = manifest(42);
        state.setManifest(existing);
        state.alive.add(existing.pid);
        const supervisor = new ServerArtifactSupervisor(
            '/profile',
            { artifactRoot: '/server' },
            { adapter: state.adapter },
        );
        const lifecycle: ServerSupervisionEvent[] = [];
        supervisor.onLifecycle((event) => lifecycle.push(event));
        await supervisor.ensure();

        supervisor.releaseProcess(existing.pid);
        state.alive.delete(existing.pid);
        state.clearManifest();
        await supervisor.ensure();

        expect(lifecycle).toEqual([]);
        expect(state.launch).toHaveBeenCalledOnce();
    });
});
