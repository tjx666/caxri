import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

/**
 * Installs a user extension whose single expanded row carries two inline actions, the first behind a confirmation,
 * shaped like the Status panel's pull request row and its Merge action. The confirmed command only bumps a counter
 * shown in the child row, so the spec observes dispatch without any real `gh` call.
 */
async function writeRowActionsExtension(extensionRoot: string): Promise<void> {
    await mkdir(join(extensionRoot, 'dist'), { recursive: true });
    await mkdir(join(extensionRoot, 'media'), { recursive: true });
    const desktopManifestSource = await readFile(
        new URL('../package.json', import.meta.url),
        'utf8',
    );
    const desktopVersion = (JSON.parse(desktopManifestSource) as { version: string }).version;
    await writeFile(
        join(extensionRoot, 'package.json'),
        JSON.stringify({
            name: 'e2e.row-actions',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: desktopVersion },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'e2e.row-actions',
                            title: 'Row Actions Fixture',
                            icon: { kind: 'resource', path: 'media/row-actions.svg' },
                        },
                    ],
                },
                views: {
                    'e2e.row-actions': [
                        { id: 'e2e.row-actions.tree', name: 'Row Actions Tree', type: 'tree' },
                    ],
                },
                commands: [
                    { command: 'e2e.row-actions.merge', title: 'Merge Fixture' },
                    { command: 'e2e.row-actions.open', title: 'Open Fixture' },
                ],
            },
        }),
    );
    await writeFile(
        join(extensionRoot, 'dist', 'extension.js'),
        `import caxri, { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'caxri';
export function activate(context) {
    let merges = 0;
    const changed = new EventEmitter();
    context.subscriptions.push(
        caxri.views.registerTreeDataProvider('e2e.row-actions.tree', {
            onDidChangeTreeData: changed.event,
            getChildren: (element) => (element ? ['Merges: ' + merges] : ['Pull request #7']),
            getTreeItem: (label) => {
                if (label !== 'Pull request #7') {
                    const child = new TreeItem(label);
                    child.id = 'merge-count';
                    return child;
                }
                const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
                item.id = 'pull-request';
                item.actions = [
                    {
                        command: { command: 'e2e.row-actions.merge', title: 'Merge Fixture' },
                        icon: new ThemeIcon('git-merge'),
                        confirmation: {
                            title: 'Merge fixture pull request?',
                            message: 'The fixture only counts merges.',
                            confirmLabel: 'Merge',
                        },
                    },
                    {
                        command: { command: 'e2e.row-actions.open', title: 'Open Fixture' },
                        icon: new ThemeIcon('link-external'),
                    },
                ];
                return item;
            },
        }),
        caxri.commands.registerCommand('e2e.row-actions.merge', () => {
            merges += 1;
            changed.fire(undefined);
        }),
        caxri.commands.registerCommand('e2e.row-actions.open', () => {}),
    );
}
`,
    );
    await writeFile(
        join(extensionRoot, 'media', 'row-actions.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h12v12H2z"/></svg>',
    );
}

test('Extension tree inline actions are reachable and runnable from the keyboard', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-row-actions-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeRowActionsExtension(join(userData, 'extensions', 'row-actions'));
    const running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Row Actions Fixture', exact: true }).click();
        const tree = running.page.getByRole('tree', { name: 'Row Actions Tree' });
        const row = tree.getByRole('treeitem', { name: 'Pull request #7', exact: true });
        const child = tree.getByRole('treeitem', { name: 'Merges: 0', exact: true });
        // Located by command id through CSS: a hidden action is outside the accessibility tree before the row is
        // focused, and the open confirmation modal hides the whole workbench from role queries. The accessible name is
        // asserted separately below.
        const actions = running.page.locator('[role="tree"][aria-label="Row Actions Tree"]');
        const merge = actions.locator('[data-tree-item-action="e2e.row-actions.merge"]');
        const open = actions.locator('[data-tree-item-action="e2e.row-actions.open"]');
        await expect(child).toBeVisible();
        await expect(row).toHaveAccessibleDescription(
            'Actions: Merge Fixture, Open Fixture. Press Right Arrow to reach them.',
        );
        // The actions stay out of the tab order until the keyboard enters them, so the tree keeps one Tab stop.
        await expect(merge).toHaveAttribute('tabindex', '-1');

        await expect(merge).toBeHidden();

        await row.focus();
        await expect(merge).toBeVisible();
        await expect(merge).toHaveAccessibleName('Merge Fixture');
        // Down still enters an expanded row's child; Right, treegrid style, enters the row's actions instead.
        await running.page.keyboard.press('ArrowDown');
        await expect(child).toBeFocused();
        await running.page.keyboard.press('ArrowLeft');
        await expect(row).toBeFocused();
        await running.page.keyboard.press('ArrowRight');
        await expect(merge).toBeFocused();
        await expect(merge).toHaveAttribute('tabindex', '0');
        await tree.screenshot({ path: test.info().outputPath('row-action-focused.png') });

        await running.page.keyboard.press('ArrowRight');
        await expect(open).toBeFocused();
        await expect(merge).toHaveAttribute('tabindex', '-1');
        await running.page.keyboard.press('ArrowRight');
        await expect(open).toBeFocused();
        await running.page.keyboard.press('ArrowLeft');
        await expect(merge).toBeFocused();
        await running.page.keyboard.press('ArrowLeft');
        await expect(row).toBeFocused();
        await running.page.keyboard.press('ArrowRight');
        await expect(merge).toBeFocused();
        await running.page.keyboard.press('Escape');
        await expect(row).toBeFocused();
        // The row stays expanded: none of the action keys reached the row's own collapse handling.
        await expect(row).toHaveAttribute('aria-expanded', 'true');
        await running.page.keyboard.press('ArrowRight');
        await expect(merge).toBeFocused();

        await running.page.keyboard.press('Enter');
        const dialog = running.page.getByRole('dialog', { name: 'Merge fixture pull request?' });
        await expect(dialog).toBeVisible();
        await expect(merge).toHaveAttribute('aria-busy', 'true');
        // Shift+Tab must also wait for the modal's initial focus; pressed earlier it moves focus from the busy action.
        await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeFocused();
        await running.page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await running.page.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(merge).toBeFocused();
        await expect(merge).not.toHaveAttribute('aria-busy');
        await expect(child).toBeVisible();

        await running.page.keyboard.press(' ');
        await expect(dialog).toBeVisible();
        // Enter must wait for the modal's initial focus: until then it lands on the busy action, which ignores it.
        await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeFocused();
        await running.page.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(tree.getByRole('treeitem', { name: 'Merges: 1', exact: true })).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
