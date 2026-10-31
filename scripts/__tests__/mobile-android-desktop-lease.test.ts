import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../../.agents/skills/switch-worktree/scripts/desktop-lease';
import { runCapture } from '../../.agents/skills/switch-worktree/scripts/process';
import { createAndroidAcceptanceDesktopLease } from '../mobile-android-desktop-lease';

const temporaryDirectories: string[] = [];
const inheritedToken = process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-android-lease-'));
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
    if (inheritedToken === undefined) delete process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;
    else process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN = inheritedToken;
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('Android Acceptance desktop lease', () => {
    it('hands its token to the cases and frees the desktop on release', async () => {
        delete process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;
        const root = await createRepo();
        const lease = createAndroidAcceptanceDesktopLease(root);

        await lease.claim();
        const status = await inspectDesktopLease(root);
        expect(status.state).toBe('active');
        expect(process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN).toBeTruthy();

        await lease.release();
        expect(process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN).toBeUndefined();
        expect((await inspectDesktopLease(root)).state).toBe('free');
    });

    it('names the sibling that holds the desktop and how long the round waited', async () => {
        delete process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN;
        const root = await createRepo();
        const sibling = await acquireDesktopLease(root, 'Sibling E2E', process.pid);
        const messages: string[] = [];
        const lease = createAndroidAcceptanceDesktopLease(root, (message) =>
            messages.push(message),
        );

        const claimed = lease.claim();
        await expect.poll(() => messages.length).toBe(1);
        await releaseDesktopLease(sibling);
        await claimed;
        await lease.release();

        expect(messages[0]).toBe('Waiting for the desktop lease held by Sibling E2E (repository)');
        expect(messages[1]).toMatch(/^Desktop lease acquired after \d+s$/u);
    });

    it('keeps an inherited coordinator token instead of claiming a second lease', async () => {
        process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN = 'inherited-token';
        const root = await createRepo();
        const lease = createAndroidAcceptanceDesktopLease(root);

        await lease.claim();
        expect((await inspectDesktopLease(root)).state).toBe('free');
        await lease.release();
        expect(process.env.CAXRI_DESKTOP_COORDINATOR_TOKEN).toBe('inherited-token');
    });
});
