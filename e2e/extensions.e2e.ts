import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
    verifyBottomEdgeTreeTooltip,
    verifyColdRightEdgeTreeTooltip,
    verifyTreeTooltipPositioning,
} from './support/extension-tooltip.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    typeTerminal,
} from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

async function writePersistenceExtension(extensionRoot: string): Promise<void> {
    await mkdir(join(extensionRoot, 'dist'), { recursive: true });
    await mkdir(join(extensionRoot, 'media'), { recursive: true });
    const desktopManifestUrl = new URL('../package.json', import.meta.url);
    const desktopManifestSource = await readFile(desktopManifestUrl, 'utf8');
    const desktopVersion = (JSON.parse(desktopManifestSource) as { version: string }).version;
    await writeFile(
        join(extensionRoot, 'package.json'),
        JSON.stringify({
            name: 'e2e.persistence',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: desktopVersion },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'e2e.persistence',
                            title: 'Persistence Fixture',
                            icon: { kind: 'resource', path: 'media/persistence.svg' },
                        },
                    ],
                },
                views: {
                    'e2e.persistence': [
                        {
                            id: 'e2e.persistence.tree',
                            name: 'Persistence Fixture',
                            type: 'tree',
                        },
                    ],
                },
            },
        }),
    );
    await writeFile(
        join(extensionRoot, 'dist', 'extension.js'),
        `import caxri, { TreeItem } from 'caxri';
export function activate(context) {
    context.subscriptions.push(caxri.views.registerTreeDataProvider('e2e.persistence.tree', {
        getChildren: () => ['Persistent selection'],
        getTreeItem: (label) => new TreeItem(label),
    }));
}
`,
    );
    await writeFile(
        join(extensionRoot, 'media', 'persistence.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h12v12H2z"/></svg>',
    );
}

test('tree tooltip keeps its first cursor open inside the right viewport edge', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-tooltip-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Extension Fixture', exact: true }).click();
        const tree = running.page.getByRole('tree', { name: 'Fixture Tree' });
        await expect(
            tree.getByRole('treeitem', { name: 'Tooltip row', exact: true }),
        ).toBeVisible();
        await verifyColdRightEdgeTreeTooltip(running.page, tree);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('extension fixture lazily activates a bounded virtualized keyboard tree', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-tree-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    let running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        const fixtureTab = running.page.getByRole('tab', {
            name: 'Extension Fixture',
            exact: true,
        });
        await expect(fixtureTab).toBeVisible();
        await fixtureTab.click();
        await expect(
            running.page.getByRole('status', { name: 'Loading view…', exact: true }),
        ).toBeVisible();

        const tree = running.page.getByRole('tree', { name: 'Fixture Tree' });
        const lazy = tree.getByRole('treeitem', { name: 'Lazy children', exact: true });
        await expect(lazy).toBeVisible();
        expect(await tree.getByRole('treeitem').count()).toBeLessThan(80);

        const providerExpanded = tree.getByRole('treeitem', {
            name: 'Provider expanded',
            exact: true,
        });
        await expect(providerExpanded).toHaveAttribute('aria-expanded', 'true');
        await expect(
            tree.getByRole('treeitem', { name: 'Expanded child', exact: true }),
        ).toBeVisible();

        await verifyTreeTooltipPositioning(running.page, tree, fixtureTab);

        await tree.getByRole('treeitem', { name: 'Command count: 0', exact: true }).click();
        await expect(
            tree.getByRole('treeitem', { name: 'Command count: 1', exact: true }),
        ).toBeVisible();
        await tree.getByRole('treeitem', { name: 'Command count: 1', exact: true }).dblclick();
        await expect(
            tree.getByRole('treeitem', { name: 'Command count: 2', exact: true }),
        ).toBeVisible();
        const keyboardCommand = tree.getByRole('treeitem', {
            name: 'Command count: 2',
            exact: true,
        });
        await keyboardCommand.focus();
        await keyboardCommand.press('Enter');
        await expect(
            tree.getByRole('treeitem', { name: 'Command count: 3', exact: true }),
        ).toBeVisible();

        const deepTree = tree.getByRole('treeitem', { name: 'Deep tree', exact: true });
        await deepTree.click();
        const levelOne = tree.getByRole('treeitem', { name: 'Level 1 item 1', exact: true });
        await levelOne.click();
        const levelTwo = tree.getByRole('treeitem', { name: 'Level 2 item 1', exact: true });
        await expect(levelTwo).toBeVisible();

        await deepTree.click({ modifiers: ['Alt'] });
        await expect(deepTree).toHaveAttribute('aria-expanded', 'false');
        await expect(levelOne).toHaveCount(0);

        await deepTree.click();
        await expect(levelOne).toHaveAttribute('aria-expanded', 'false');
        await expect(levelTwo).toHaveCount(0);
        await deepTree.click();
        await deepTree.click({ modifiers: ['Alt'] });
        await expect(levelOne).toHaveAttribute('aria-expanded', 'true');
        await expect(levelTwo).toBeVisible();
        await expect(levelTwo).toHaveAttribute('aria-expanded', 'false');

        await lazy.focus();
        await lazy.press('ArrowRight');
        await expect(lazy).toHaveAttribute('aria-expanded', 'true');
        const alpha = tree.getByRole('treeitem', { name: 'Alpha', exact: true });
        await expect(alpha).toBeVisible();
        await expect(alpha).toHaveAttribute('aria-level', '2');
        await expect(alpha).toHaveAttribute('aria-posinset', '1');
        await expect(alpha).toHaveAttribute('aria-setsize', '2');
        await lazy.press('ArrowLeft');
        await expect(lazy).toHaveAttribute('aria-expanded', 'false');

        await lazy.press('End');
        const last = tree.getByRole('treeitem', { name: 'Virtual row 399', exact: true });
        await expect(last).toBeFocused();
        await verifyBottomEdgeTreeTooltip(running.page, last);
        await last.focus();
        await last.press('Home');
        await expect(lazy).toBeFocused();

        /**
         * A wheel scroll moves the virtual window without moving the roving row. The row that owns the tree's single
         * Tab stop must stay rendered anyway: once it unmounted, no row carried `tabIndex=0` and Tab skipped the whole
         * tree until the user scrolled back (issue #1012).
         */
        const tabStops = tree.locator('[role="treeitem"][tabindex="0"]');
        await tree.hover();
        await running.page.mouse.wheel(0, 20_000);
        await expect(last).toBeVisible();
        await expect(tabStops).toHaveCount(1);
        await expect(tabStops).toHaveAccessibleName('Lazy children');
        await expect(lazy).toBeFocused();
        await running.page.mouse.wheel(0, -20_000);
        await expect(lazy).toBeInViewport();

        await lazy.press('ArrowRight');
        await expect(lazy).toHaveAttribute('aria-expanded', 'true');
        await expect(alpha).toBeVisible();
        await alpha.focus();
        await expect(alpha).toHaveAttribute('aria-selected', 'true');

        const targeted = tree.getByRole('treeitem', { name: 'Targeted refresh', exact: true });
        await targeted.click();
        await expect(targeted).toHaveAttribute('aria-expanded', 'true');
        await expect(
            tree.getByRole('treeitem', { name: 'Target child 0', exact: true }),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Extension Fixture Target', { exact: true }).click();
        await expect(targeted).toHaveAttribute('aria-expanded', 'true');
        await expect(
            tree.getByRole('treeitem', { name: 'Target child 1', exact: true }),
        ).toBeVisible();

        const empty = tree.getByRole('treeitem', { name: 'Empty children', exact: true });
        await empty.click();
        await expect(
            running.page.getByText('No items in this view.', { exact: true }),
        ).toBeVisible();

        await providerExpanded.click();
        await expect(providerExpanded).toHaveAttribute('aria-expanded', 'false');
        await alpha.focus();
        await expect(alpha).toHaveAttribute('aria-selected', 'true');
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Extension Fixture', { exact: true }).click();
        await expect(lazy).toHaveAttribute('aria-expanded', 'true');
        await expect(targeted).toHaveAttribute('aria-expanded', 'true');
        await expect(providerExpanded).toHaveAttribute('aria-expanded', 'false');
        await expect(alpha).toHaveAttribute('aria-selected', 'true');

        const providerError = tree.getByRole('treeitem', {
            name: 'Provider error',
            exact: true,
        });
        await providerError.click();
        await expect(
            running.page.getByText('Unable to load view: Fixture provider failure', {
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: 'Retry', exact: true }),
        ).toBeVisible();
        await providerError.click();
        await expect(providerError).toHaveAttribute('aria-expanded', 'false');
        /**
         * The error row scrolls Alpha outside the virtual window. Use tree navigation to reveal it before checking
         * selection; focusing an unmounted row cannot scroll it into existence.
         */
        await providerError.press('Home');
        await expect(lazy).toBeFocused();
        await lazy.press('ArrowDown');
        await expect(alpha).toBeFocused();
        await expect(alpha).toHaveAttribute('aria-selected', 'true');

        const firstSession = await pageRequest<{ selectedSessionId: string }>(
            running.page,
            'app.bootstrap',
        );
        await createAdditionalShellSession(running.page);
        await fixtureTab.click();
        await expect(lazy).toHaveAttribute('aria-expanded', 'false');
        await sessionCard(running.page, firstSession.selectedSessionId).click();
        await expect(fixtureTab).toHaveAttribute('aria-selected', 'true');
        await expect(lazy).toHaveAttribute('aria-expanded', 'true');
        await expect(alpha).toHaveAttribute('aria-selected', 'true');

        await running.app.close();
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
        });
        const restoredTree = running.page.getByRole('tree', { name: 'Fixture Tree' });
        await expect(
            restoredTree.getByRole('treeitem', { name: 'Lazy children', exact: true }),
        ).toHaveAttribute('aria-expanded', 'true');
        await expect(
            restoredTree.getByRole('treeitem', { name: 'Alpha', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Extension Host crash preserves Terminal state and desired ViewContainer across recovery', async () => {
    allowE2EErrors([
        {
            source: 'server-core',
            event: 'extension_host.exit',
            code: 'EXTENSION_HOST_EXIT',
            count: 1,
        },
        { source: 'desktop', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
        // The crash below also reaches the user as one Extension Host exit notification.
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-crash-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        const fixtureTab = running.page.getByRole('tab', {
            name: 'Extension Fixture',
            exact: true,
        });
        await fixtureTab.click();
        await expect(
            running.page.getByRole('treeitem', { name: 'Lazy children', exact: true }),
        ).toBeVisible();
        const lazy = running.page.getByRole('treeitem', {
            name: 'Lazy children',
            exact: true,
        });
        await lazy.click();
        const alpha = running.page.getByRole('treeitem', { name: 'Alpha', exact: true });
        await expect(alpha).toBeVisible();
        await alpha.focus();

        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Crash Extension Host', { exact: true }).click();
        await expect
            .poll(async () => {
                const catalog = await pageRequest<{
                    extensions: Array<{ id: string; generation: number }>;
                }>(running.page, 'viewContainers.catalog');
                return catalog.extensions.find(({ id }) => id === 'caxri.fixture')?.generation;
            })
            .toBeGreaterThan(1);
        await expect(fixtureTab).toHaveAttribute('aria-selected', 'true');
        await expect(lazy).toHaveAttribute('aria-expanded', 'true');
        await expect(alpha).toHaveAttribute('aria-selected', 'true');

        await typeTerminal(running.page, String.raw`printf 'EXTENSION_HOST_RECOVERY_OK\n'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'EXTENSION_HOST_RECOVERY_OK',
        );
        const bootstrap = await pageRequest<{
            selectedSessionId?: string;
            sessionStates: Array<{
                sessionId: string;
                desiredSecondarySidebarViewContainerId: string;
            }>;
        }>(running.page, 'app.bootstrap');
        expect(
            bootstrap.sessionStates.find(
                ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
            )?.desiredSecondarySidebarViewContainerId,
        ).toBe('caxri.fixture');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('missing installed extension falls back without overwriting desired selection and rebinds after restore', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-persistence-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const extensionRoot = join(userData, 'extensions', 'persistence');
    const disabledRoot = join(testDirectory, 'persistence-disabled');
    await mkdir(root, { recursive: true });
    await writePersistenceExtension(extensionRoot);

    let running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        const persistenceTab = running.page.getByRole('tab', {
            name: 'Persistence Fixture',
            exact: true,
        });
        await persistenceTab.click();
        await expect(
            running.page.getByRole('treeitem', { name: 'Persistent selection', exact: true }),
        ).toBeVisible();
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<{
                    selectedSessionId?: string;
                    sessionStates: Array<{
                        sessionId: string;
                        desiredSecondarySidebarViewContainerId: string;
                    }>;
                }>(running.page, 'app.bootstrap');
                return bootstrap.sessionStates.find(
                    ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
                )?.desiredSecondarySidebarViewContainerId;
            })
            .toBe('e2e.persistence');
        await running.app.close();

        await rename(extensionRoot, disabledRoot);
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
        });
        await expect(running.page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        let bootstrap = await pageRequest<{
            selectedSessionId?: string;
            sessionStates: Array<{
                sessionId: string;
                desiredSecondarySidebarViewContainerId: string;
            }>;
        }>(running.page, 'app.bootstrap');
        expect(
            bootstrap.sessionStates.find(
                ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
            )?.desiredSecondarySidebarViewContainerId,
        ).toBe('e2e.persistence');
        await running.app.close();

        await rename(disabledRoot, extensionRoot);
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
        });
        await expect(
            running.page.getByRole('tab', { name: 'Persistence Fixture', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.getByRole('treeitem', { name: 'Persistent selection', exact: true }),
        ).toBeVisible();
        bootstrap = await pageRequest(running.page, 'app.bootstrap');
        expect(
            bootstrap.sessionStates.find(
                ({ sessionId }) => sessionId === bootstrap.selectedSessionId,
            )?.desiredSecondarySidebarViewContainerId,
        ).toBe('e2e.persistence');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
