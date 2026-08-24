import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    openAddProjectDialog,
    pageRequest,
    sessionCard,
    typeTerminal,
} from './support/helpers.ts';
import { stubPackagedProjectDialog } from './support/packaged-project-dialog.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

async function writePersistenceExtension(extensionRoot: string): Promise<void> {
    await mkdir(join(extensionRoot, 'dist'), { recursive: true });
    await mkdir(join(extensionRoot, 'media'), { recursive: true });
    await writeFile(
        join(extensionRoot, 'package.json'),
        JSON.stringify({
            name: 'e2e.persistence',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
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

test('bundled Project Status extension renders and refreshes the current repository tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-status-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const statusTitlePath = join(testDirectory, 'status-title.txt');
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'feature/status'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@caxri.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Fixture'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'Project Status fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: root });
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
        { cwd: root },
    );
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/feature/status', 'HEAD'], {
        cwd: root,
    });
    await execFileAsync(
        'git',
        ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/status'],
        { cwd: root },
    );
    await writeFile(statusTitlePath, 'Status A');
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
status_title=$(cat ${JSON.stringify(statusTitlePath)})
printf '{"body":"Related to https://linear.app/lobehub/issue/LOBE-42/project-status","number":42,"title":"%s","url":"https://github.com/tjx666/project/pull/42","statusCheckRollup":[{"workflowName":"Test","name":"App","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-08-23T00:00:00.000Z","completedAt":"2026-08-23T00:02:05.000Z"}]}' "$status_title"
`,
        'utf8',
    );
    await writeFile(
        join(bin, 'linear'),
        "#!/bin/sh\nprintf 'Linear fixture failed\\n' >&2\nexit 1\n",
        'utf8',
    );
    await writeFile(
        join(bin, 'vc'),
        `#!/bin/sh
case " $* " in
  *" teams ls "*) printf '%s' '{"teams":[{"slug":"tjx666"}]}' ;;
  *" githubCommitRef="*) printf '%s' '[{"name":"project","readyState":"BUILDING","target":"preview","url":"branch-preview.vercel.app"}]' ;;
  *" --environment production "*) printf '%s' '[{"name":"project","readyState":"READY","target":"production","url":"project.example.com"}]' ;;
  *" --environment preview "*) printf '%s' '[{"name":"project","readyState":"ERROR","target":"preview","url":"preview-project.vercel.app"}]' ;;
  *) printf '%s' '[{"name":"project","readyState":"READY","target":"production","url":"discovery.vercel.app"}]' ;;
esac
`,
        'utf8',
    );
    await Promise.all(['gh', 'linear', 'vc'].map((name) => chmod(join(bin, name), 0o755)));

    let running = await launchCaxri({
        executablePath: packagedExecutable,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        await stubPackagedProjectDialog(running, root, packagedExecutable);
        await openAddProjectDialog(running.page);
        try {
            await running.page
                .getByRole('dialog')
                .getByRole('button', { name: 'Shell', exact: true })
                .click({ timeout: 5_000 });
        } catch {
            // The Shell button may already have been dismissed by an earlier auto-selection.
        }
        await expect(running.page.locator('.session-card')).toHaveCount(1);
        const statusTab = running.page.getByRole('tab', { name: 'Status', exact: true });
        await statusTab.click();
        await expect(statusTab.locator('img')).toHaveCount(0);
        await expect(statusTab.locator('svg')).toHaveCount(1);

        const tree = running.page.getByRole('tree', { name: 'Project Status' });
        const repo = tree.getByRole('treeitem', { name: 'project', exact: true });
        await expect(repo).toBeVisible();
        await expect(repo).toHaveAttribute('aria-expanded', 'true');
        await expect(
            tree.getByRole('treeitem', { name: 'feature/status, default', exact: true }),
        ).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Project Status', { exact: true }).click();
        const pullRequestA = tree.getByRole('treeitem', { name: '#42 Status A', exact: true });
        await expect(pullRequestA).toBeVisible();
        await expect(pullRequestA).toHaveAttribute('aria-expanded', 'true');
        await expect(pullRequestA.locator('[data-theme-icon="circle-x"]')).toHaveClass(
            /text-danger/,
        );
        await expect(
            tree.getByRole('treeitem', { name: 'Test / App, 2m 5s', exact: true }),
        ).toBeVisible();
        const deployments = tree.getByRole('treeitem', {
            name: 'Deployments, 1 on preview',
            exact: true,
        });
        await expect(deployments).toBeVisible();
        await expect(
            tree.getByRole('treeitem', { name: 'Production, project.example.com', exact: true }),
        ).toBeVisible();
        await expect(
            tree.getByRole('treeitem', {
                name: 'Preview, preview-project.vercel.app',
                exact: true,
            }),
        ).toBeVisible();

        const linearError = tree.getByRole('treeitem', { name: /linear: error/i });
        await expect(linearError).toBeVisible();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toHaveCount(0);
        await linearError.click();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toBeVisible();
        await expect(running.page.getByRole('tab', { name: 'Logs', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );

        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string }>;
        }>(running.page, 'keybindings.get');
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                [
                    ...keybindings.value,
                    { command: 'caxri.project-status.refresh', key: 'cmd+alt+r' },
                ],
                null,
                2,
            ),
        });
        await writeFile(statusTitlePath, 'Status B');
        await deployments.click();
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        const production = tree.getByRole('treeitem', {
            name: 'Production, project.example.com',
            exact: true,
        });
        await production.focus();
        await expect(production).toHaveAttribute('aria-selected', 'true');
        await running.page.keyboard.press('Meta+Alt+r');
        await expect(
            tree.getByRole('treeitem', { name: '#42 Status B', exact: true }),
        ).toBeVisible();
        await expect(pullRequestA).toHaveCount(0);
        await expect(deployments).toHaveAttribute('aria-expanded', 'true');
        await expect(production).toHaveAttribute('aria-selected', 'true');
        await running.page.waitForTimeout(150);

        await running.app.close();
        running = await launchCaxri({
            executablePath: packagedExecutable,
            userDataDir: userData,
            testRootPath: root,
            env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        await running.page.getByRole('tab', { name: 'Status', exact: true }).click();
        const restoredTree = running.page.getByRole('tree', { name: 'Project Status' });
        /**
         * Activation restores the tree asynchronously. Wait for that request before forcing another refresh so the
         * fixture validates refresh persistence instead of racing two provider generations under CI load.
         */
        await expect(
            restoredTree.getByRole('treeitem', { name: '#42 Status B', exact: true }),
        ).toBeVisible();
        await writeFile(statusTitlePath, 'Status C');
        /**
         * The custom shortcut is already proven before relaunch. Use the restored extension's command palette entry
         * here so this recovery assertion starts a new provider generation only after command registration is ready.
         */
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Project Status', { exact: true }).click();
        await expect(
            restoredTree.getByRole('treeitem', { name: '#42 Status C', exact: true }),
        ).toBeVisible();
        const restoredDeployments = restoredTree.getByRole('treeitem', {
            name: 'Deployments, 1 on preview',
            exact: true,
        });
        await expect(restoredDeployments).toHaveAttribute('aria-expanded', 'true');
        await expect(
            restoredTree.getByRole('treeitem', {
                name: 'Production, project.example.com',
                exact: true,
            }),
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

test('extension fixture lazily activates a bounded virtualized keyboard tree', async () => {
    allowE2EErrors([{ source: 'main', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 }]);
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
        await expect(running.page.getByText('Loading view…', { exact: true })).toBeVisible();

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

        const tooltipRow = tree.getByRole('treeitem', { name: 'Tooltip row', exact: true });
        await tooltipRow.hover();
        await expect(running.page.locator('.tooltip-popup')).toContainText('Full fixture tooltip');

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
        await last.press('Home');
        await expect(lazy).toBeFocused();

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
        await alpha.focus();
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
            source: 'host',
            event: 'host.extension_host_exit',
            code: 'HOST_EXTENSION_HOST_EXIT',
            count: 1,
        },
        { source: 'main', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
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
