import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    openAddProjectDialog,
    pageRequest,
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
                            icon: 'media/persistence.svg',
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
    await execFileAsync('mkdir', ['-p', root, bin]);
    await execFileAsync('git', ['init', '-b', 'feature/status'], { cwd: root });
    await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/tjx666/project.git'],
        { cwd: root },
    );
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
printf '%s' '${JSON.stringify({
            body: 'Related to https://linear.app/lobehub/issue/LOBE-42/project-status',
            number: 42,
            title: 'Project Status navigation',
            url: 'https://github.com/tjx666/project/pull/42',
            statusCheckRollup: [],
        })}'
`,
        'utf8',
    );
    await writeFile(
        join(bin, 'linear'),
        "#!/bin/sh\nprintf 'Linear fixture failed\\n' >&2\nexit 1\n",
        'utf8',
    );
    await writeFile(join(bin, 'vc'), "#!/bin/sh\nprintf '%s' '{\"teams\":[]}'\n", 'utf8');
    await Promise.all(['gh', 'linear', 'vc'].map((name) => chmod(join(bin, name), 0o755)));

    const running = await launchCaxri({
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
        await running.page.getByRole('tab', { name: 'Status', exact: true }).click();

        const tree = running.page.getByRole('tree', { name: 'Extension View' });
        const repo = tree.getByRole('treeitem', { name: 'project, feature/status' });
        await expect(repo).toBeVisible();
        await expect(repo).toHaveAttribute('aria-expanded', 'false');
        await repo.click();
        await expect(repo).toHaveAttribute('aria-expanded', 'true');
        await expect(tree.getByRole('treeitem', { name: 'feature/status, Branch' })).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Refresh Project Status', { exact: true }).click();
        await expect(repo).toBeVisible();

        const linearError = tree.getByRole('treeitem', { name: /linear: error/i });
        await expect
            .poll(async () => {
                if ((await repo.getAttribute('aria-expanded')) === 'false') await repo.click();
                return linearError.count();
            })
            .toBe(1);
        await expect(linearError).toBeVisible();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toHaveCount(0);
        await linearError.click();
        await expect(running.page.getByRole('region', { name: 'Panel' })).toBeVisible();
        await expect(running.page.getByRole('tab', { name: 'Logs', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
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
        await expect(fixtureTab).toBeVisible();
        await fixtureTab.click();
        await expect(running.page.getByText('Loading view…', { exact: true })).toBeVisible();

        const tree = running.page.getByRole('tree', { name: 'Extension View' });
        const lazy = tree.getByRole('treeitem', { name: 'Lazy children', exact: true });
        await expect(lazy).toBeVisible();
        expect(await tree.getByRole('treeitem').count()).toBeLessThan(80);

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

        const providerError = tree.getByRole('treeitem', {
            name: 'Provider error',
            exact: true,
        });
        await providerError.click();
        await expect(
            running.page.getByText('Fixture provider failure', { exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: 'Retry', exact: true }),
        ).toBeVisible();
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
        await expect(
            running.page.getByRole('treeitem', { name: 'Lazy children', exact: true }),
        ).toBeVisible();

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
