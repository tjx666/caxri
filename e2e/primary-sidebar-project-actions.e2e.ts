import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, createProjectSession, launchCaxri } from './support/helpers.ts';

test('Project actions reveal on hover or focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-primary-sidebar-affordances-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const projectHeading = running.page.locator('.project-heading');
        const newSession = projectHeading.getByRole('button', {
            name: /^New (?:.+ )?Session in project$/u,
        });
        const projectDisclosure = projectHeading.getByRole('button', {
            name: 'Collapse project',
        });
        await expect(projectHeading.locator('.project-disclosure')).toHaveCount(1);
        // The chevron carries the disclosure state; the folder glyph sits beside the Project name as identity and a
        // custom icon replaces it there without taking the cue away (issue #993).
        await expect(projectDisclosure.locator('svg')).toHaveClass(/lucide-chevron-down/);
        await expect(projectHeading.locator('.project-select .project-folder-icon')).toHaveClass(
            /lucide-folder-open/,
        );
        // The heading names its Session count, so the accessible name is never the bare title.
        const projectName = projectHeading.getByRole('treeitem', { name: 'project (1 Session)' });
        await projectDisclosure.click();
        /**
         * The chevron is `tabIndex={-1}` and unknown to the tree's key handling, so a click that left focus on it
         * stranded the arrow keys. It hands focus to the heading's own treeitem instead, and the tree keys work from
         * there (issue #1012).
         */
        await expect(projectName).toBeFocused();
        const collapsedDisclosure = projectHeading.getByRole('button', {
            name: 'Expand project',
        });
        await expect(collapsedDisclosure.locator('svg')).toHaveClass(/lucide-chevron-right/);
        await expect(projectHeading.locator('.project-select .project-folder-icon')).toHaveClass(
            /lucide-folder-closed/,
        );
        await running.page.keyboard.press('ArrowRight');
        await expect(projectDisclosure.locator('svg')).toHaveClass(/lucide-chevron-down/);
        await projectDisclosure.click();
        await collapsedDisclosure.click();
        await expect(projectName).toBeFocused();
        await projectName.click();
        await expect(projectHeading.getByRole('button', { name: 'Expand project' })).toBeVisible();
        await expect(running.page.locator('.project-session-disclosure')).toHaveAttribute(
            'data-expanded',
            'false',
        );
        await projectName.click();
        await expect(
            projectHeading.getByRole('button', { name: 'Collapse project' }),
        ).toBeVisible();
        await expect(running.page.locator('.session-list')).toBeVisible();
        const selectedSession = running.page.locator('.session-card.active');
        await selectedSession.focus();
        await expect(selectedSession).toHaveCSS('box-shadow', 'none');
        await running.page.mouse.move(500, 300);
        await expect(newSession).toHaveCSS('opacity', '0');
        await projectHeading.hover();
        await expect(newSession).toHaveCSS('opacity', '1');
        await running.page.mouse.move(500, 300);
        /**
         * The actions reveal for keyboard focus (`:focus-visible`). A scripted `focus()` after pointer input does not
         * match it, so reach the heading the way a keyboard user does: up from its selected Session.
         */
        await selectedSession.focus();
        await running.page.keyboard.press('ArrowUp');
        await expect(projectName).toBeFocused();
        await expect(newSession).toHaveCSS('opacity', '1');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('the heading New Session tooltip stays clear of the list it opens beside it', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-primary-sidebar-tooltip-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        // The remembered Agent turns the button into a split whose press is named by a tooltip.
        const newSession = running.page
            .locator('.project-heading')
            .getByRole('button', { name: /^New .+ Session in project$/u });
        /**
         * Hover opens the list 100ms before the tooltip, so the two always share the screen. A synthesized hover is
         * unreliable on CI, so focus raises the tooltip and ArrowDown opens the list; the tooltip is measured first
         * because ArrowDown highlights the first row, whose own tooltip then takes the shared popup.
         */
        await newSession.focus();
        const tooltip = running.page.locator('.tooltip-popup', { hasText: /^New .+ Session/u });
        await expect(tooltip).toBeVisible();
        const tooltipBox = await tooltip.boundingBox();
        await newSession.press('ArrowDown');
        const menu = running.page.getByRole('menu', { name: /^New Session in /u });
        await expect(menu).toBeVisible();
        const menuBox = await menu.boundingBox();
        expect(tooltipBox).not.toBeNull();
        expect(menuBox).not.toBeNull();
        // The list opens on the trigger's right, so the tooltip must end left of it rather than cross it.
        expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(menuBox!.x);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
