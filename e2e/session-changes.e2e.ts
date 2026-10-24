import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function initRepo(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'Session changes fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
}

/**
 * The count logic, scope rule, and invalidation exemption are unit-tested; only a real launch proves the card reaches
 * the Server for a Session in another root, that the Server re-reads a working tree no file watcher follows, and that
 * the selected Session's own card leaves the count to the Git tab badge (issue #859).
 */
test('Session hover card counts another root’s uncommitted changes but not the selected Session’s', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-changes-e2e-'));
    const alpha = join(directory, 'alpha');
    const beta = join(directory, 'beta');
    await Promise.all([initRepo(alpha), initRepo(beta)]);
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: alpha,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([alpha, beta]) },
    });
    try {
        const { page } = running;
        const alphaSessionId = await createProjectSession(page);
        const betaRoot = await pageRequest<string | null>(page, 'dialog.selectDirectory');
        if (betaRoot !== beta) throw new Error('Unexpected beta Project root');
        const betaProject = await pageRequest<{ id: string }>(page, 'project.create', {
            rootPath: betaRoot,
        });
        const betaSession = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
            projectId: betaProject.id,
            defaultAgent: null,
        });
        const betaSessionId = betaSession.session.id;
        await pageRequest(page, 'session.rename', {
            displayTitle: 'alpha work',
            sessionId: alphaSessionId,
        });
        await pageRequest(page, 'session.rename', {
            displayTitle: 'beta work',
            sessionId: betaSessionId,
        });
        /*
         * Reading beta once while it is selected leaves the Server a cached snapshot of a clean tree. Moving the
         * selection to alpha then stops the file watcher from following beta, so the edits below never advance that
         * snapshot on their own: the stale-count case the card has to see through.
         */
        await pageRequest(page, 'session.select', { sessionId: betaSessionId });
        const betaClean = await pageRequest<{ repositories: Array<{ changedFileCount: number }> }>(
            page,
            'git.overview',
            { sessionId: betaSessionId },
        );
        expect(betaClean.repositories[0].changedFileCount).toBe(0);
        await pageRequest(page, 'session.select', { sessionId: alphaSessionId });
        await expect(sessionCard(page, alphaSessionId)).toHaveAttribute('aria-selected', 'true');

        await writeFile(join(beta, 'README.md'), 'Edited while another Session was selected\n');
        await writeFile(join(beta, 'notes.md'), 'New file\n');
        await writeFile(join(alpha, 'README.md'), 'Edited in the selected Session\n');

        const card = page.locator('.session-activity-card');
        await sessionCard(page, betaSessionId).hover();
        await expect(card).toContainText('beta work');
        const changes = card.locator('.session-card-changes');
        await expect(changes).toHaveText('2 changes');
        await expect(sessionCard(page, betaSessionId)).toHaveAccessibleDescription(
            /Working tree has 2 uncommitted changes\./,
        );
        await card.screenshot({ path: test.info().outputPath('other-root-changes.png') });

        await page.keyboard.press('Escape');
        await expect(card).toHaveCount(0);
        await sessionCard(page, alphaSessionId).hover();
        await expect(card).toContainText('alpha work');
        await expect(card).toContainText('Opened');
        await expect(card.locator('.session-card-changes')).toHaveCount(0);
        await card.screenshot({ path: test.info().outputPath('selected-session-card.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
