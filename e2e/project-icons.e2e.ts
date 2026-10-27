import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

function projectHeading(page: Page, projectId: string) {
    return page.locator(`.project-heading[data-project-id="${projectId}"]`);
}

test('customizes, persists, and clears a controlled Project icon', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-icon-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = ['custom', 'default'].map((name) => join(testDirectory, name));
    await Promise.all(roots.map((root) => mkdir(root)));
    const launchOptions = {
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        const initial = await pageRequest<{
            projects: Array<{ title: string; id: string; rootPath: string }>;
        }>(running.page, 'app.bootstrap');
        if (initial.projects.length !== 1)
            throw new Error('Custom Project fixture was not created');
        const customProject = initial.projects[0];
        const defaultRoot = await pageRequest<string | null>(
            running.page,
            'dialog.selectDirectory',
        );
        if (defaultRoot !== roots[1]) throw new Error('Default Project grant was not consumed');
        const defaultProject = await pageRequest<{ id: string }>(running.page, 'project.create', {
            rootPath: defaultRoot,
        });

        const customHeading = projectHeading(running.page, customProject.id);
        await customHeading.locator('.project-select').hover();
        await expect(running.page.locator('.project-details-card')).toBeVisible();
        await customHeading
            .getByRole('button', {
                name: `Customize Project Icon for ${customProject.title}`,
            })
            .click();
        const dialog = running.page.getByRole('dialog', { name: 'Customize Project Icon' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Database' }).click();
        await dialog.getByRole('button', { name: 'Warning color' }).click();
        await dialog.getByRole('button', { name: 'Save' }).click();

        await expect(
            customHeading.locator('[data-project-icon="database"][data-project-color="warning"]'),
        ).toBeVisible();
        await expect(
            projectHeading(running.page, defaultProject.id).locator(
                '[data-project-icon="default-folder"]',
            ),
        ).toBeVisible();
        await running.page.locator('.session-card').hover();
        await expect(
            running.page
                .locator('.session-activity-card')
                .locator('[data-project-icon="database"]'),
        ).toBeVisible();

        await running.app.close();
        running = await launchCaxri(launchOptions);
        const restoredHeading = projectHeading(running.page, customProject.id);
        await expect(
            restoredHeading.locator('[data-project-icon="database"][data-project-color="warning"]'),
        ).toBeVisible();
        await expect(
            projectHeading(running.page, defaultProject.id).locator(
                '[data-project-icon="default-folder"]',
            ),
        ).toBeVisible();

        await restoredHeading.hover();
        await restoredHeading.getByRole('button', { name: /Customize Project Icon for/ }).click();
        await running.page
            .getByRole('dialog', { name: 'Customize Project Icon' })
            .getByRole('button', { name: 'Clear icon' })
            .click();
        await expect(restoredHeading.locator('[data-project-icon="default-folder"]')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
