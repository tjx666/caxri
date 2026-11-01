import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

async function expectFullyVisible(locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
    expect(
        await locator.evaluate(
            (element) =>
                element.scrollWidth <= element.clientWidth &&
                element.scrollHeight <= element.clientHeight,
        ),
    ).toBe(true);
}

test('Project Status presents a non-Git Project as a complete message', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-status-empty-state-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    let running: RunningCaxri | undefined;
    try {
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
        });
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);

        await running.page
            .getByRole('tablist', { name: 'Secondary Side Bar' })
            .getByRole('tab', { name: 'Status', exact: true })
            .click();

        const tree = running.page.getByRole('tree', { name: 'Project Status' });
        const message = tree.getByRole('treeitem', {
            name: 'No Git repository, Initialize a Git repository in the Project root, then refresh.',
            exact: true,
        });
        await expect(message).toHaveAttribute('data-tree-item-variant', 'message');
        const icon = message.locator('[data-theme-icon="git-branch"]');
        await expect(icon).toBeVisible();
        await expect(icon).not.toHaveClass(/text-danger/);
        await expectFullyVisible(message.locator('[data-slot="empty-title"]'));
        await expectFullyVisible(message.locator('[data-slot="empty-description"]'));

        const refresh = message.getByRole('button', { name: 'Refresh', exact: true });
        await expect(refresh).toBeEnabled();
        /**
         * The Refresh button is disabled only while the single root load is pending, about 35 ms locally. A hosted
         * runner can return from `click()` after that window closed, so polling `toBeDisabled()` there misses a
         * transition that did happen. Record every state change from before the click and assert the history instead.
         */
        const refreshStates = await running.page.evaluateHandle(() => {
            const tree = document.querySelector('[role="tree"][aria-label="Project Status"]');
            const states: boolean[] = [];
            const read = () => {
                const button = [...(tree?.querySelectorAll('button') ?? [])].find(
                    (candidate) =>
                        (candidate.getAttribute('aria-label') ?? candidate.textContent).trim() ===
                        'Refresh',
                );
                if (button && states.at(-1) !== button.disabled) states.push(button.disabled);
            };
            read();
            new MutationObserver(read).observe(tree!, {
                attributes: true,
                childList: true,
                subtree: true,
            });
            return states;
        });
        await refresh.click();
        await expect
            .poll(() => refreshStates.evaluate((states) => states.join(',')))
            .toBe('false,true,false');
        await expect(message).toBeFocused();
        await expect(message).toBeVisible();
        await expect(refresh).toBeEnabled();
        await running.page.keyboard.press('Enter');
        await expect(message).toBeVisible();

        await message.hover();
        await expect(running.page.locator('.tooltip-popup:visible')).toHaveCount(0);
        await expect(running.page.locator('.tree-item-rich-tooltip:visible')).toHaveCount(0);

        await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
        await writeFile(join(root, 'README.md'), 'Project Status fixture\n', 'utf8');
        await execFileAsync('git', ['add', 'README.md'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });

        await running.page
            .getByRole('button', { name: 'Refresh Project Status', exact: true })
            .click();
        const repo = tree.getByRole('treeitem', { name: 'project', exact: true });
        const branch = tree.getByRole('treeitem', {
            name: 'main, No origin, add a GitHub remote named origin to compare it',
            exact: true,
        });
        await expect(repo).toHaveAttribute('data-tree-item-variant', 'header');
        await expect(branch).toBeVisible();
        await expect
            .poll(async () => {
                const repoBox = await repo.boundingBox();
                const branchBox = await branch.boundingBox();
                if (!repoBox || !branchBox) return;
                return branchBox.y - (repoBox.y + repoBox.height);
            })
            .toBeLessThanOrEqual(1);
    } finally {
        await running?.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
