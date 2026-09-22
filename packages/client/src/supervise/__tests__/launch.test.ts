import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, expect, it, vi } from 'vitest';

import { launchServer } from '../launch';

const { spawn, mkdir, resolveServerArtifact } = vi.hoisted(() => ({
    spawn: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    resolveServerArtifact: vi.fn().mockResolvedValue({
        executablePath: '/fixture/runtime/node',
        entryPath: '/fixture/server.js',
    }),
}));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs/promises', () => ({ mkdir }));
vi.mock('../artifact.js', () => ({ resolveServerArtifact }));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

it('keeps detached Server descendants attributable to their CI owner', async () => {
    vi.stubEnv('CAXRI_RUNNER_OWNER', 'caxri-42-1-e2e');
    vi.stubEnv('UNRELATED_SECRET', 'excluded-fixture');
    // eslint-disable-next-line unicorn/prefer-event-target -- child_process uses EventEmitter, not EventTarget.
    const child = Object.assign(new EventEmitter(), { pid: 123, unref: vi.fn() });
    spawn.mockImplementation(() => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
    });

    await expect(launchServer('/fixture/profile', { artifactRoot: '/fixture' })).resolves.toEqual({
        pid: 123,
    });
    const options = spawn.mock.calls[0][2] as SpawnOptions;
    expect(options.detached).toBe(true);
    expect(options.env?.CAXRI_RUNNER_OWNER).toBe('caxri-42-1-e2e');
    expect(options.env?.UNRELATED_SECRET).toBeUndefined();
});
