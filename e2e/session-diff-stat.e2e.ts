import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
} from './support/helpers.ts';

/**
 * The base selection, untracked counting, and caching are unit- and integration-tested; only a real launch proves the
 * sidebar poll reaches the row, that `git.changed` moves the count without waiting for the next poll, and that a clean
 * tree hides it.
 */
test('Session row shows its Workbench Root’s line diff and follows working-tree edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'caxri-session-diff-stat-e2e-'));
    const repo = join(root, 'project');
    await execFileAsync('mkdir', ['-p', repo]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'Session diff fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: repo });
    const running = await launchCaxri({
        userDataDir: join(root, 'user-data'),
        testRootPath: repo,
    });
    try {
        const { page } = running;
        const sessionId = await createProjectSession(page);
        await pageRequest(page, 'session.rename', { displayTitle: 'diff work', sessionId });
        const row = sessionCard(page, sessionId);
        const diffStat = row.locator('.session-diff-stat');
        await expect(row.locator('.session-status-line')).toBeVisible();
        await expect(diffStat).toHaveCount(0);

        await writeFile(join(repo, 'README.md'), 'Edited by the Agent\n');
        await writeFile(join(repo, 'notes.md'), 'first\nsecond\n');

        await expect(diffStat).toHaveText('+3−1', { timeout: 15_000 });
        await expect(row).toHaveAccessibleDescription(/Branch changes: 3 lines added, 1 removed\./);
        // The stat and the title line's delivery track end on one right edge, so a PR glyph sits directly above it.
        const rightEdges = await row.evaluate((element) =>
            ['.session-diff-stat', '.session-indicators'].map(
                (selector) => element.querySelector(selector)?.getBoundingClientRect().right,
            ),
        );
        expect(rightEdges[0]).toBeDefined();
        expect(rightEdges[0]).toBe(rightEdges[1]);
        await page
            .locator('.session-primary-sidebar')
            .screenshot({ path: test.info().outputPath('session-row-diff-stat.png') });

        await execFileAsync('git', ['checkout', '--', 'README.md'], { cwd: repo });
        await rm(join(repo, 'notes.md'));
        await expect(diffStat).toHaveCount(0, { timeout: 15_000 });
    } finally {
        await closeAppQuietly(running.app);
        await rm(root, { recursive: true, force: true });
    }
});
