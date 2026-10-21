import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

/**
 * Installs a user extension whose row action stands in for the Status panel's pull request merge: the command keeps
 * running until the active Session changes, then counts the merge. Waiting on the switch instead of a timer makes the
 * regression deterministic: while a running Extension command held the connection's ordered lane, the Session switch
 * queued behind the very command waiting for it.
 */
async function writeSlowMergeExtension(extensionRoot: string): Promise<void> {
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
            name: 'e2e.slow-merge',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: desktopVersion },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'e2e.slow-merge',
                            title: 'Slow Merge Fixture',
                            icon: { kind: 'resource', path: 'media/slow-merge.svg' },
                        },
                    ],
                },
                views: {
                    'e2e.slow-merge': [
                        { id: 'e2e.slow-merge.tree', name: 'Slow Merge Tree', type: 'tree' },
                    ],
                },
                commands: [{ command: 'e2e.slow-merge.merge', title: 'Merge Fixture' }],
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
        caxri.views.registerTreeDataProvider('e2e.slow-merge.tree', {
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
                        command: { command: 'e2e.slow-merge.merge', title: 'Merge Fixture' },
                        icon: new ThemeIcon('git-merge'),
                    },
                ];
                return item;
            },
        }),
        caxri.commands.registerCommand('e2e.slow-merge.merge', async () => {
            await new Promise((resolve) => {
                const subscription = caxri.workspace.onDidChangeActiveContext(() => {
                    subscription.dispose();
                    resolve();
                });
            });
            merges += 1;
            changed.fire(undefined);
        }),
    );
}
`,
    );
    await writeFile(
        join(extensionRoot, 'media', 'slow-merge.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h12v12H2z"/></svg>',
    );
}

test('a running Extension command does not hold up a Session switch', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-extension-session-switch-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeSlowMergeExtension(join(userData, 'extensions', 'slow-merge'));
    const running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const { page } = running;
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await createShellSession(page);
        const firstSessionId = await selectedSessionId(page);
        await createAdditionalShellSession(page);

        const fixtureTab = page.getByRole('tab', { name: 'Slow Merge Fixture', exact: true });
        await fixtureTab.click();
        const tree = page.getByRole('tree', { name: 'Slow Merge Tree' });
        const row = tree.getByRole('treeitem', { name: 'Pull request #7', exact: true });
        const merge = page
            .locator('[role="tree"][aria-label="Slow Merge Tree"]')
            .locator('[data-tree-item-action="e2e.slow-merge.merge"]');
        await expect(tree.getByRole('treeitem', { name: 'Merges: 0', exact: true })).toBeVisible();
        await row.focus();
        await page.keyboard.press('ArrowRight');
        await expect(merge).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(merge).toHaveAttribute('aria-busy', 'true');

        // The merge only finishes once the active Session changes, so this switch has to overtake it.
        await sessionCard(page, firstSessionId).click();
        await expect.poll(() => selectedSessionId(page)).toBe(firstSessionId);

        await fixtureTab.click();
        await expect(tree.getByRole('treeitem', { name: 'Merges: 1', exact: true })).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
