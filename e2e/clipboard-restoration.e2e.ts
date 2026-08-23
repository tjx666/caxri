import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import {
    isClipboardFixtureCurrent,
    snapshotClipboard,
    writeClipboardFixture,
} from './support/clipboard.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';
import { resolveE2EWorkerIsolation } from './support/worker-isolation.ts';

const projectRoot = resolve(import.meta.dirname, '..');

async function verifyFormatRoundTrip(closeMode: 'native-quit' | 'playwright-close'): Promise<void> {
    const testDirectory = await mkdtemp(join(tmpdir(), `caxri-clipboard-${closeMode}-`));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        clipboard: true,
        clipboardFixture: 'custom-formats',
        testRootPath: root,
        userDataDir: userData,
    });
    let isClosed = false;
    try {
        expect(running.clipboard.metadata).toMatchObject({
            formatCount: 4,
            itemCount: 2,
        });
        await running.clipboard.writeText('CAXRI_E2E_CLIPBOARD_REPLACEMENT');

        if (closeMode === 'playwright-close') {
            await running.app.close();
        } else {
            const closed = running.app.waitForEvent('close');
            try {
                await running.app.evaluate(({ app }) => app.quit());
            } catch {
                // The evaluation transport may close while graceful quit is the operation under test.
            }
            await closed;
            await running.app.close();
        }
        isClosed = true;
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // The shared error gate reports content-free cleanup failures.
            }
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
}

test('native clipboard formats round-trip through app.close and graceful app.quit', async () => {
    await verifyFormatRoundTrip('playwright-close');
    await verifyFormatRoundTrip('native-quit');
});

test('an external pasteboard generation is preserved during teardown', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-clipboard-external-write-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        clipboard: true,
        testRootPath: root,
        userDataDir: userData,
    });
    const recoverySnapshot = await snapshotClipboard();
    let externalGeneration: number | undefined;
    let wasExternalWritePreserved: boolean;
    let isClosed = false;
    try {
        await running.clipboard.writeText('CAXRI_E2E_TEST_OWNED_GENERATION');
        externalGeneration = (await writeClipboardFixture('external-write')).generation;
        await running.app.close();
        isClosed = true;
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // The shared error gate reports content-free cleanup failures.
            }
        }
        const workerIsolation = resolveE2EWorkerIsolation(process.env);
        const recoveryLease = await acquireDesktopLease(
            projectRoot,
            'Electron E2E clipboard fixture recovery',
            process.pid,
            {
                coordinatorToken: workerIsolation.coordinatorToken,
                namespace: workerIsolation.leaseNamespace,
            },
        );
        try {
            wasExternalWritePreserved = await isClipboardFixtureCurrent('external-write');
            if (externalGeneration !== undefined && wasExternalWritePreserved) {
                recoverySnapshot.claimGeneration(externalGeneration);
                await recoverySnapshot.restore();
            }
            await recoverySnapshot.dispose();
        } finally {
            await releaseDesktopLease(recoveryLease);
        }
        await rm(testDirectory, { recursive: true, force: true });
    }

    expect(wasExternalWritePreserved).toBe(true);
});
