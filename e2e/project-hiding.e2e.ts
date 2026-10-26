import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    openAddProjectDialog,
    pageRequest,
} from './support/helpers.ts';

interface BootstrapFixture {
    projects: Array<{ id: string; rootPath: string }>;
    sessions: Array<{ id: string; projectId: string }>;
    selectedProjectId?: string;
    selectedSessionId?: string;
}

test('Hide Project removes it from the sidebar and re-adding the folder restores only its Sessions', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-hiding-e2e-'));
    const keeperRoot = join(testDirectory, 'keeper');
    const hiddenRoot = join(testDirectory, 'hidden-project');
    await Promise.all([mkdir(keeperRoot), mkdir(hiddenRoot)]);
    // Test folder grants are consumed in order: keeper, the Project to hide, then the same folder again to restore it.
    const roots = [keeperRoot, hiddenRoot, hiddenRoot];
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: keeperRoot,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    });
    const { page } = running;
    const hiddenHeading = page.locator('.project-heading', { hasText: 'hidden-project' });
    try {
        await createProjectSession(page);
        const hiddenSessionId = await createProjectSession(page);
        const before = await pageRequest<BootstrapFixture>(page, 'app.bootstrap');
        const hiddenProject = before.projects.find((project) =>
            project.rootPath.endsWith('hidden-project'),
        );
        if (!hiddenProject || before.selectedProjectId !== hiddenProject.id)
            throw new Error('Hidden Project fixture was not selected');
        await expect(hiddenHeading).toBeVisible();

        await page.keyboard.press('Meta+Shift+P');
        const palette = page.getByRole('dialog', { name: 'Command Palette' });
        await palette.getByRole('combobox').fill('Hide Project');
        await palette.getByRole('option', { name: /Hide Project/ }).click();

        await expect(hiddenHeading).toHaveCount(0);
        const hidden = await pageRequest<BootstrapFixture>(page, 'app.bootstrap');
        expect(hidden.projects.map(({ id }) => id)).not.toContain(hiddenProject.id);
        expect(hidden.sessions.map(({ id }) => id)).not.toContain(hiddenSessionId);
        expect(hidden.selectedProjectId).not.toBe(hiddenProject.id);

        // A restore skips the Terminal choice and selects the old Session instead of creating another one.
        await openAddProjectDialog(page);

        await expect(hiddenHeading).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await pageRequest<BootstrapFixture>(page, 'app.bootstrap')).selectedSessionId,
            )
            .toBe(hiddenSessionId);
        const restored = await pageRequest<BootstrapFixture>(page, 'app.bootstrap');
        expect(restored.projects.map(({ id }) => id)).toContain(hiddenProject.id);
        expect(
            restored.sessions
                .filter(({ projectId }) => projectId === hiddenProject.id)
                .map(({ id }) => id),
        ).toEqual([hiddenSessionId]);
        await expect(page.getByRole('heading', { name: 'Start a Session' })).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
