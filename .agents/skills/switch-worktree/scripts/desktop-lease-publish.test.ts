import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireDesktopLease, inspectDesktopLease, releaseDesktopLease } from './desktop-lease';
import { runCapture } from './process';

/**
 * Regression seam for the acquire-time TOCTOU (#161): the pre-fix writer created the lease file with `open('wx')` and
 * wrote its content in a separate step, so a lock-free reader could observe an empty file. The gate pauses any `'wx'`
 * open after the file exists, turning that microsecond window into a deterministic breakpoint. The fixed writer
 * publishes atomically via a synced temp file and `link(2)`, so it never opens the lease path with `'wx'` and never
 * enters the gate.
 */
const exclusiveOpenGate: { pause?: () => Promise<void> } = {};

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        open: async (...openArguments: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...openArguments);
            if (openArguments[1] === 'wx' && exclusiveOpenGate.pause) {
                await exclusiveOpenGate.pause();
            }
            return handle;
        },
    };
});

const temporaryDirectories: string[] = [];

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-desktop-publish-'));
    temporaryDirectories.push(temporary);
    const root = join(temporary, 'repository');
    await mkdir(root);
    await runCapture('git', ['init', '-b', 'main'], root);
    await runCapture('git', ['config', 'user.email', 'caxri@example.invalid'], root);
    await runCapture('git', ['config', 'user.name', 'Caxri Test'], root);
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await runCapture('git', ['add', 'README.md'], root);
    await runCapture('git', ['commit', '-m', 'initial'], root);
    return root;
}

afterEach(async () => {
    exclusiveOpenGate.pause = undefined;
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('desktop lease publication', () => {
    it('never exposes a partially published lease to lock-free inspection', async () => {
        const root = await createRepo();
        let openGateEntered!: () => void;
        const windowReached = new Promise<void>((resolve) => (openGateEntered = resolve));
        let releaseWriter!: () => void;
        const writerResumes = new Promise<void>((resolve) => (releaseWriter = resolve));
        exclusiveOpenGate.pause = async () => {
            openGateEntered();
            await writerResumes;
        };

        const acquisition = acquireDesktopLease(root, 'paused publisher');
        // Pre-fix the writer parks inside the empty-file window and `windowReached` wins the
        // race; post-fix the atomic publisher never opens `'wx'` and the acquisition wins.
        await Promise.race([
            windowReached,
            (async () => {
                await acquisition;
            })(),
        ]);

        // The core invariant: a lock-free inspection during publication must either see a free
        // desktop or a complete lease, never fail parsing a half-written file.
        const status = await inspectDesktopLease(root);
        expect(['free', 'active']).toContain(status.state);

        releaseWriter();
        const lease = await acquisition;
        expect((await inspectDesktopLease(root)).state).toBe('active');
        await releaseDesktopLease(lease);
        expect((await inspectDesktopLease(root)).state).toBe('free');
    }, 30_000);
});
