import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { allowE2EErrors, expect, test } from './fixtures.ts';

import { launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('issue-104-error-gate: observes a page exception while the UI remains usable', async () => {
    allowE2EErrors([
        {
            source: 'main',
            event: 'renderer.page_exception',
            code: 'PAGE_EXCEPTION',
            count: 1,
        },
        {
            source: 'main',
            event: 'renderer.console_error',
            code: 'CONSOLE_ERROR',
            count: 1,
        },
        { source: 'renderer', event: 'pageerror', code: 'PAGE_ERROR', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-error-gate-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.evaluate(() => {
            setTimeout(() => {
                throw new Error('CAXRI_EXPECTED_E2E_PAGE_EXCEPTION');
            });
        });
        const mainLogPath = join(userData, 'logs', 'main.jsonl');
        await expect
            .poll(() => readFile(mainLogPath, 'utf8'))
            .toContain('"event":"renderer.page_exception"');
        await expect(running.page.getByLabel('Add Project')).toBeAttached();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
