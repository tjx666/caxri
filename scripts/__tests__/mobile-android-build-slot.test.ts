import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from '../../.agents/skills/switch-worktree/scripts/process';
import { withAndroidBuildSlot } from '../mobile-android-build-slot';

const temporaryDirectories: string[] = [];

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-android-slot-'));
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
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('withAndroidBuildSlot', () => {
    it('queues a build beyond the slot count until a slot frees', async () => {
        const root = await createRepo();
        const deadlineMs = Date.now() + 30_000;
        let running = 0;
        let peak = 0;
        const order: string[] = [];
        const { promise: firstHolds, resolve: releaseFirst } = Promise.withResolvers<void>();
        const build = (name: string, hold?: Promise<void>) =>
            withAndroidBuildSlot(
                root,
                async () => {
                    running += 1;
                    peak = Math.max(peak, running);
                    order.push(`start ${name}`);
                    await (hold ?? Promise.resolve());
                    running -= 1;
                    order.push(`end ${name}`);
                },
                { deadlineMs, slotCount: 1 },
            );

        const first = build('first', firstHolds);
        await expect.poll(() => order).toEqual(['start first']);
        let didWait = false;
        const second = withAndroidBuildSlot(
            root,
            () => {
                order.push('start second');
            },
            {
                deadlineMs,
                onWait: () => {
                    didWait = true;
                },
                slotCount: 1,
            },
        );
        await expect.poll(() => didWait).toBe(true);
        releaseFirst();
        await Promise.all([first, second]);

        expect(peak).toBe(1);
        expect(order).toEqual(['start first', 'end first', 'start second']);
    });

    it('runs builds side by side up to the slot count and frees a slot after a failure', async () => {
        const root = await createRepo();
        const deadlineMs = Date.now() + 30_000;
        const { promise: hold, resolve: releaseBoth } = Promise.withResolvers<void>();
        let running = 0;
        const holding = () =>
            withAndroidBuildSlot(
                root,
                async () => {
                    running += 1;
                    await hold;
                },
                { deadlineMs, slotCount: 2 },
            );
        const builds = [holding(), holding()];
        await expect.poll(() => running).toBe(2);
        releaseBoth();
        await Promise.all(builds);

        await expect(
            withAndroidBuildSlot(
                root,
                () => {
                    throw new Error('gradle failed');
                },
                { deadlineMs, slotCount: 1 },
            ),
        ).rejects.toThrow('gradle failed');
        await expect(
            withAndroidBuildSlot(root, () => 'built', { deadlineMs, slotCount: 1 }),
        ).resolves.toBe('built');
    });

    it('fails instead of waiting past the deadline', async () => {
        const root = await createRepo();
        const { promise: hold, resolve: release } = Promise.withResolvers<void>();
        let isHolding = false;
        const holder = withAndroidBuildSlot(
            root,
            async () => {
                isHolding = true;
                await hold;
            },
            { deadlineMs: Date.now() + 30_000, slotCount: 1 },
        );
        await expect.poll(() => isHolding).toBe(true);

        await expect(
            withAndroidBuildSlot(root, () => {}, {
                deadlineMs: Date.now() + 100,
                slotCount: 1,
            }),
        ).rejects.toThrow('Timed out waiting for an Android Acceptance build slot');
        release();
        await holder;
    });
});
