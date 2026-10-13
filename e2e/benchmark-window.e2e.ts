import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageReply, pageRequest } from './support/helpers.ts';

/**
 * Benchmark opens as its own companion window, like the Agent Commander: one instance, the Workbench's Projects in its
 * workspace picker, and Main refusing any request outside the Benchmark window's allowlist.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Benchmark opens once in its own window and offers every Project', async ({}, testInfo) => {
    // The request the Benchmark window is not allowed to send, refused on purpose below.
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'FORBIDDEN', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-benchmark-window-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'benchmark-project');
    await mkdir(root);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        // Adding the test root as a Project gives the workspace picker something beyond the empty folder.
        await createShellSession(running.page);
        await pageRequest(running.page, 'benchmark.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const benchmark = running.app.windows().find((page) => page !== running.page)!;
        await expect(benchmark.locator('[data-benchmark-window]')).toBeVisible();
        await expect(benchmark).toHaveTitle('Benchmark — Caxri');

        // A second open focuses the existing window instead of creating another.
        await pageRequest(running.page, 'benchmark.open');
        await expect.poll(() => running.app.windows().length).toBe(2);

        await benchmark.getByRole('combobox', { name: 'Where each run works' }).click();
        await expect(benchmark.getByRole('option')).toHaveText([
            'Empty folder',
            'Copy of benchmark-project',
        ]);
        await testInfo.attach('benchmark-window', {
            body: await benchmark.screenshot(),
            contentType: 'image/png',
        });
        await benchmark.keyboard.press('Escape');

        const denied = await pageReply(benchmark, 'session.create', {});
        expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
