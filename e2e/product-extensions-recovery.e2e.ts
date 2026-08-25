import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../src/shared/node/exec.ts';
import type { Locator, Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

const productionExtensions = [
    { containerId: 'caxri.files', name: 'Files', viewKind: 'resource-explorer' },
    { containerId: 'caxri.git', name: 'Git', viewKind: 'source-control' },
    { containerId: 'caxri.project-status', name: 'Status', viewKind: 'tree' },
] as const;

interface Catalog {
    containers: Array<{
        id: string;
        source: { kind: string; extensionId?: string };
    }>;
    extensions: Array<{ id: string; generation: number; lifecycle: string }>;
    views: Array<{
        containerId: string;
        source: { kind: string; extensionId?: string };
        viewKind: { kind: string };
    }>;
}

interface Bootstrap {
    selectedSessionId?: string;
    sessionStates: Array<{
        desiredSecondarySidebarViewContainerId?: string;
        sessionId: string;
    }>;
}

function sidebarTab(page: Page, name: string): Locator {
    return page
        .getByRole('tablist', { name: 'Secondary Side Bar' })
        .getByRole('tab', { name, exact: true });
}

async function expectSelectedContainer(page: Page, expectedId: string): Promise<void> {
    const bootstrap = await pageRequest<Bootstrap>(page, 'app.bootstrap');
    const selected = bootstrap.sessionStates.find(
        ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
    )?.desiredSecondarySidebarViewContainerId;
    expect(selected).toBe(expectedId);
    expect(selected).not.toBe('caxri.fixture');
}

async function expectFilesData(page: Page): Promise<void> {
    await expect(
        page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', {
            name: 'README.md',
            exact: true,
        }),
    ).toBeVisible();
}

async function expectGitData(page: Page): Promise<void> {
    await expect(page.locator('.git-repository-section')).toHaveCount(1);
    await expect(page.locator('.git-row[title="README.md"]')).toBeVisible();
}

async function expectStatusData(page: Page): Promise<void> {
    await expect(page.getByRole('tree', { name: 'Project Status' })).toBeVisible();
}

test('product Files, Git, and Status selections persist and recover after Extension Host restart', async () => {
    allowE2EErrors([
        {
            source: 'host',
            event: 'host.extension_host_exit',
            code: 'HOST_EXTENSION_HOST_EXIT',
            count: 1,
        },
        { source: 'main', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
    ]);

    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-product-extension-recovery-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), 'Product extension recovery fixture\n', 'utf8');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Initial product extension fixture'], {
        cwd: root,
    });
    await writeFile(join(root, 'README.md'), 'Working tree change\n', 'utf8');

    let running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        const fixtureTab = sidebarTab(running.page, 'Extension Fixture');
        await expect(sidebarTab(running.page, 'Files')).toBeVisible();
        await expect(sidebarTab(running.page, 'Git')).toBeVisible();
        await expect(sidebarTab(running.page, 'Status')).toBeVisible();
        // The deliberate crash command is supplied only by the explicit E2E extension artifact.
        await expect(fixtureTab).toBeVisible();

        const catalog = await pageRequest<Catalog>(running.page, 'viewContainers.catalog');
        for (const extension of productionExtensions) {
            expect(catalog.containers.find(({ id }) => id === extension.containerId)).toMatchObject(
                {
                    id: extension.containerId,
                    source: { kind: 'extension', extensionId: extension.containerId },
                },
            );
            expect(
                catalog.views.find(({ containerId }) => containerId === extension.containerId),
            ).toMatchObject({
                containerId: extension.containerId,
                source: { kind: 'extension', extensionId: extension.containerId },
                viewKind: { kind: extension.viewKind },
            });
        }

        const relaunchAndAssert = async (
            containerId: string,
            tabName: string,
            assertData: (page: Page) => Promise<void>,
        ): Promise<void> => {
            await running.app.close();
            running = await launchCaxri({
                executablePath: packagedExecutable,
                userDataDir: userData,
                testRootPath: root,
            });
            await expect(sidebarTab(running.page, tabName)).toHaveAttribute(
                'aria-selected',
                'true',
            );
            await assertData(running.page);
            await expectSelectedContainer(running.page, containerId);
        };

        const filesTab = sidebarTab(running.page, 'Files');
        await filesTab.click();
        await expect(filesTab).toHaveAttribute('aria-selected', 'true');
        await expectFilesData(running.page);
        await expectSelectedContainer(running.page, 'caxri.files');
        await relaunchAndAssert('caxri.files', 'Files', expectFilesData);

        const gitTab = sidebarTab(running.page, 'Git');
        await gitTab.click();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expectGitData(running.page);
        await expectSelectedContainer(running.page, 'caxri.git');
        await relaunchAndAssert('caxri.git', 'Git', expectGitData);

        const statusTab = sidebarTab(running.page, 'Status');
        await statusTab.click();
        await expect(statusTab).toHaveAttribute('aria-selected', 'true');
        await expectStatusData(running.page);
        await expectSelectedContainer(running.page, 'caxri.project-status');
        await relaunchAndAssert('caxri.project-status', 'Status', expectStatusData);

        // Activate the test-only extension so its deliberate crash command is registered, then return to Files. The
        // persisted/current selection must remain a product extension before and after the crash.
        const restoredFixtureTab = sidebarTab(running.page, 'Extension Fixture');
        await restoredFixtureTab.click();
        await expect(
            running.page.getByRole('tree', { name: 'Fixture Tree' }).getByRole('treeitem', {
                name: 'Lazy children',
                exact: true,
            }),
        ).toBeVisible();
        const currentFilesTab = sidebarTab(running.page, 'Files');
        await currentFilesTab.click();
        await expect(currentFilesTab).toHaveAttribute('aria-selected', 'true');
        await expectFilesData(running.page);
        await expectSelectedContainer(running.page, 'caxri.files');

        const beforeCrash = await pageRequest<Catalog>(running.page, 'viewContainers.catalog');
        const beforeGenerations = new Map(
            productionExtensions.map(({ containerId }) => [
                containerId,
                beforeCrash.extensions.find(({ id }) => id === containerId)?.generation ?? 0,
            ]),
        );
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Crash Extension Host', { exact: true }).click();
        await expect
            .poll(async () => {
                try {
                    const recovered = await pageRequest<Catalog>(
                        running.page,
                        'viewContainers.catalog',
                    );
                    return productionExtensions.every(({ containerId }) => {
                        const extension = recovered.extensions.find(({ id }) => id === containerId);
                        return (
                            extension !== undefined &&
                            extension.generation > (beforeGenerations.get(containerId) ?? 0) &&
                            extension.lifecycle !== 'crashed'
                        );
                    });
                } catch {
                    return false;
                }
            })
            .toBe(true);
        await expect(currentFilesTab).toHaveAttribute('aria-selected', 'true');
        await expectFilesData(running.page);
        await expectSelectedContainer(running.page, 'caxri.files');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
