import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withAgentHookInstallLock } from '../install-lock';

const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

const roots: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    const pending = [...roots];
    roots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
});

async function sharedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-hook-lock-'));
    roots.push(root);
    return root;
}

function lockPath(root: string): string {
    return join(root, 'install.lock');
}

async function holderOf(root: string): Promise<string | undefined> {
    try {
        const marker = await readFile(join(lockPath(root), 'owner.json'), 'utf8');
        return (JSON.parse(marker) as { holderId?: string }).holderId;
    } catch {
        return undefined;
    }
}

/**
 * Lets the lock's real filesystem work land between the fake retry timers. `advanceTimersByTimeAsync` drains the timer
 * queue against pending microtasks only, so without a real turn of the event loop in between the next retry never gets
 * scheduled and the clock runs out on a caller that is still waiting on `readFile`.
 */
/* eslint-disable no-await-in-loop -- each turn of the loop has to settle before the next one is worth taking */
async function tick(times = 1): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS);
    }
}

async function waitForHolder(root: string, previous?: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const holder = await holderOf(root);
        if (holder !== undefined && holder !== previous) return holder;
        await tick();
    }
    throw new Error('The install lock was never marked with a new holder');
}
/* eslint-enable no-await-in-loop */

async function isLocked(root: string): Promise<boolean> {
    try {
        await stat(lockPath(root));
        return true;
    } catch {
        return false;
    }
}

describe('withAgentHookInstallLock', () => {
    it('admits one caller at a time', async () => {
        const root = await sharedRoot();
        let inside = 0;
        let peak = 0;

        await Promise.all(
            Array.from({ length: 5 }, () =>
                withAgentHookInstallLock(root, async () => {
                    inside += 1;
                    peak = Math.max(peak, inside);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    inside -= 1;
                }),
            ),
        );

        expect(peak).toBe(1);
        expect(await isLocked(root)).toBe(false);
    });

    /**
     * The interleaving the fault lived in. A holds the lock, B judges it abandoned and takes it over, and A then
     * finishes. Before ownership was recorded, A's release deleted whatever lock it found, B's, and a third caller
     * could walk straight into the critical section B was still inside.
     */
    it('never releases a lock another holder has taken over', async () => {
        const root = await sharedRoot();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const holding = Promise.withResolvers<void>();
        const taking = Promise.withResolvers<void>();

        const first = withAgentHookInstallLock(root, () => holding.promise);
        const firstHolder = await waitForHolder(root);

        // The holder goes quiet for longer than any install should take, which is what makes its lock reclaimable.
        vi.setSystemTime(Date.now() + STALE_LOCK_MS + 1_000);
        const second = withAgentHookInstallLock(root, () => taking.promise);
        const secondHolder = await waitForHolder(root, firstHolder);

        holding.resolve();
        await first;
        await tick();

        expect(await holderOf(root)).toBe(secondHolder);
        taking.resolve();
        await second;
        await tick();
        expect(await isLocked(root)).toBe(false);
    });

    /**
     * A lock with no readable marker is one this process cannot attribute, so it waits it out rather than assuming it
     * is free. Preempting on an unreadable marker would be the same fault with an extra step.
     */
    it('waits out an unattributable lock instead of seizing it', async () => {
        const root = await sharedRoot();
        await mkdir(lockPath(root));
        await writeFile(join(lockPath(root), 'owner.json'), 'not json at all', 'utf8');
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

        const attempt = withAgentHookInstallLock(root, () => Promise.resolve('installed'));
        const settled = expect(attempt).rejects.toThrow('Timed out waiting for the lifecycle hook');
        await tick(LOCK_TIMEOUT_MS / LOCK_RETRY_MS + 20);

        await settled;
        expect(await holderOf(root)).toBeUndefined();
    });

    it.each([
        { basis: 'a marker from a holder that never came back', marked: true },
        { basis: 'a directory left behind before it was ever marked', marked: false },
    ])('reclaims $basis', async ({ marked }) => {
        const root = await sharedRoot();
        await mkdir(lockPath(root));
        const abandonedAt = Date.now() - STALE_LOCK_MS - 1_000;
        if (marked)
            await writeFile(
                join(lockPath(root), 'owner.json'),
                JSON.stringify({ holderId: 'abandoned', writtenAt: abandonedAt }),
                'utf8',
            );
        else await utimes(lockPath(root), abandonedAt / 1000, abandonedAt / 1000);

        await expect(
            withAgentHookInstallLock(root, () => Promise.resolve('installed')),
        ).resolves.toBe('installed');
        expect(await isLocked(root)).toBe(false);
    });
});
