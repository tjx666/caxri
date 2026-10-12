import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickGitGroupAction,
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    openAddProjectDialog,
    openPanelView,
    pageReply,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    VISIBLE_SESSION,
    waitForRuntimeReady,
} from './support/helpers.ts';
import { stableWidth } from './support/motion-settle.ts';
import { runningWork } from './support/running-work.ts';

test('bundles the default terminal typeface and Nerd Font symbols', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-font-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const loadedFaces = await running.page.evaluate(async () => {
            const [regular, bold, italic, boldItalic, symbols] = await Promise.all([
                document.fonts.load('13px "Caxri JetBrains Mono"', 'Caxri'),
                document.fonts.load('700 13px "Caxri JetBrains Mono"', 'Caxri'),
                document.fonts.load('italic 13px "Caxri JetBrains Mono"', 'Caxri'),
                document.fonts.load('italic 700 13px "Caxri JetBrains Mono"', 'Caxri'),
                document.fonts.load('13px "Caxri Nerd Symbols"', '\u{E0B0}\u{F17C}'),
            ]);
            return {
                bold: bold.length,
                boldItalic: boldItalic.length,
                italic: italic.length,
                regular: regular.length,
                symbols: symbols.length,
            };
        });

        expect(loadedFaces).toEqual({
            bold: 1,
            boldItalic: 1,
            italic: 1,
            regular: 1,
            symbols: 1,
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('file changes refresh entries without collapsing expanded directories', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-refresh-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', join(root, 'nested')]);
    await writeFile(join(root, 'nested', 'inside.txt'), 'inside\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('treeitem', { name: 'nested', exact: true }).click();
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
        ).toBeVisible();
        await writeFile(join(root, 'new.txt'), 'new\n', 'utf8');

        await expect(
            running.page.getByRole('treeitem', { name: 'new.txt', exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
        ).toBeVisible();

        await running.page.locator('.panel-caption').hover();
        await running.page.getByRole('button', { name: 'Collapse Folders' }).click();
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
        ).toHaveCount(0);
        await running.page.getByRole('treeitem', { name: 'nested', exact: true }).click();
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
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

test('Option-click recursively toggles the known Files subtree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-option-click-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', join(root, 'outer', 'inner')]);
    await writeFile(join(root, 'outer', 'inner', 'inside.txt'), 'inside\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const tree = running.page.getByRole('tree', { name: 'Files' });
        const outer = tree.getByRole('treeitem', { name: 'outer', exact: true });
        const inner = tree.getByRole('treeitem', { name: 'inner', exact: true });
        const inside = tree.getByRole('treeitem', { name: 'inside.txt', exact: true });

        await outer.click();
        await inner.click();
        await expect(inside).toBeVisible();

        await outer.click({ modifiers: ['Alt'] });
        await expect(outer).toHaveAttribute('aria-expanded', 'false');
        await expect(inner).toHaveCount(0);

        await outer.click();
        await expect(inner).toHaveAttribute('aria-expanded', 'false');
        await expect(inside).toHaveCount(0);
        await outer.click();
        await outer.click({ modifiers: ['Alt'] });
        await expect(inner).toHaveAttribute('aria-expanded', 'true');
        await expect(inside).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal tabs reveal an accessible close action on hover and focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-tab-close-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pressNewTerminal(running.page);
        const terminalTabs = running.page.locator(`${VISIBLE_SESSION} .work-tab[data-terminal-id]`);
        await expect(terminalTabs).toHaveCount(2);

        const firstTab = terminalTabs.first();
        const close = firstTab.getByRole('button', { name: 'Close Terminal' });
        // The second tab's Motion entrance transition (`initial: { maxWidth: 0 }` in `work-tab.tsx`) still shrinks the
        // first tab's `flex-1 basis-0` share while it plays, so a bare read right after the tab count updates can pin
        // a stale, mid-animation baseline. Wait for it to settle before comparing against the post-hover width.
        const widthBeforeHover = await stableWidth(firstTab);
        await expect(close).toHaveCSS('opacity', '0');
        await firstTab.hover();
        await expect(close).toHaveCSS('opacity', '1');
        expect(await firstTab.evaluate((element) => element.getBoundingClientRect().width)).toBe(
            widthBeforeHover,
        );
        await firstTab.getByRole('tab').focus();
        await expect(close).toHaveCSS('opacity', '1');
        await close.click();

        await expect(terminalTabs).toHaveCount(1);
        await expect.poll(() => runningWork(running.page)).toEqual({ terminals: 1, chats: 0 });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('dragging the PrimarySidebar divider resizes it and the width survives a reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-panel-resize-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const primarySidebar = running.page.locator('.session-primary-sidebar');
        const divider = running.page.getByRole('separator', { name: 'Resize Primary Side Bar' });
        const startWidth = (await primarySidebar.boundingBox())!.width;
        const dividerBox = (await divider.boundingBox())!;
        const startX = dividerBox.x + dividerBox.width / 2;
        const y = dividerBox.y + dividerBox.height / 2;

        await running.page.mouse.move(startX, y);
        await running.page.mouse.down();
        await running.page.mouse.move(startX + 80, y, { steps: 8 });
        await running.page.mouse.up();

        await expect
            .poll(async () => (await primarySidebar.boundingBox())?.width)
            .toBeGreaterThan(startWidth + 60);
        const widthAfterDrag = Math.round((await primarySidebar.boundingBox())!.width);

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect
            .poll(async () =>
                Math.round(
                    (await running.page.locator('.session-primary-sidebar').boundingBox())!.width,
                ),
            )
            .toBe(widthAfterDrag);

        // Double-click resets to the default width shipped with `.app-shell` in styles.css.
        await running.page.getByRole('separator', { name: 'Resize Primary Side Bar' }).dblclick();
        await expect
            .poll(
                async () =>
                    (await running.page.locator('.session-primary-sidebar').boundingBox())?.width,
            )
            .toBe(230);

        // The global SecondarySidebar shortcut collapses the panel and its divider.
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.secondary-sidebar')).toHaveCount(0);
        await expect(
            running.page.getByRole('separator', { name: 'Resize Secondary Side Bar' }),
        ).toHaveCount(0);
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('primarySidebar search finds and selects Projects instead of exporting diagnostics', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-search-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const firstRoot = join(testDirectory, 'alpha-project');
    const secondRoot = join(testDirectory, 'beta-project');
    await execFileAsync('mkdir', ['-p', firstRoot, secondRoot]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: firstRoot });
    try {
        await createShellSession(running.page);
        await running.app.evaluate((_, root) => {
            process.env.CAXRI_TEST_ROOT_PATH = root;
        }, secondRoot);
        await openAddProjectDialog(running.page);
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await expect(running.page.locator('.project-group.active')).toContainText('beta-project');

        await running.page.keyboard.press('Meta+Shift+P');
        const search = running.page.getByPlaceholder('Search projects, sessions, and commands…');
        await search.fill('alpha-project');
        await running.page
            .getByLabel('Projects')
            .getByText('alpha-project', { exact: true })
            .click();

        await expect(running.page.locator('.project-group.active')).toContainText('alpha-project');
        await expect(running.page.getByRole('dialog')).toHaveCount(0);

        await running.page.keyboard.press('Meta+Shift+P');
        await running.page
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('beta-project');
        await running.page
            .getByLabel('Sessions')
            .getByRole('option')
            .filter({ hasText: 'beta-project' })
            .click();
        await expect(running.page.locator('.project-group.active')).toContainText('beta-project');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Info secondarySidebar lists only the current Session Terminals', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-multi-agent-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });

    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await expect(
            running.page.getByRole('heading', { name: 'Choose the default Terminal' }),
        ).toBeVisible();
        await running.page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();
        await expect(running.page.locator('.session-card')).toHaveCount(1);

        await openPanelView(running.page, 'Info');
        const terminalCards = running.page.locator('.terminal-info-card');
        await expect(terminalCards).toHaveCount(1);
        await expect(terminalCards.filter({ hasText: 'Codex' })).toBeVisible();
        await expect(terminalCards.filter({ hasText: 'Claude' })).toHaveCount(0);

        await pressNewTerminal(running.page);
        await expect(terminalCards).toHaveCount(2);
        await expect(terminalCards.filter({ hasText: 'Shell' })).toBeVisible();
        await expect(terminalCards.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(terminalCards.locator('[data-agent-icon="shell"]')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Git secondarySidebar shows child repositories, submodule state, and changed-file trees', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'GIT', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'GIT', count: 1 },
        // The rejected binary diff below is reported to the user as well as logged.
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-repositories-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const nested = join(root, 'nested');
    const submoduleSource = join(testDirectory, 'submodule-source');
    const bulkPaths = Array.from({ length: 12 }, (_, index) =>
        join(nested, 'packages', `bulk-${index}.ts`),
    );
    await execFileAsync('mkdir', [
        '-p',
        join(root, 'src'),
        join(nested, 'packages'),
        join(nested, 'assets'),
        join(submoduleSource, 'lib'),
    ]);
    await Promise.all(
        [root, nested, submoduleSource].map(async (repo) => {
            await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
            await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], {
                cwd: repo,
            });
            await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: repo });
        }),
    );
    await writeFile(join(root, 'src/root.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'src/root.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(nested, 'packages/nested.txt'), 'before\n', 'utf8');
    await writeFile(join(nested, 'assets/binary.bin'), Buffer.from([0, 1]));
    await Promise.all(
        bulkPaths.map((path, index) =>
            writeFile(path, `export const value${index}: number = 1;\n`, 'utf8'),
        ),
    );
    await execFileAsync('git', ['add', '.'], { cwd: nested });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: nested });
    await writeFile(join(submoduleSource, 'lib/submodule.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'lib/submodule.txt'], { cwd: submoduleSource });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: submoduleSource });
    await execFileAsync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
        { cwd: root },
    );
    await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });
    await Promise.all([
        writeFile(join(root, 'src/root.txt'), 'after\n', 'utf8'),
        writeFile(join(nested, 'packages/nested.txt'), 'after\n', 'utf8'),
        writeFile(join(nested, 'assets/binary.bin'), Buffer.from([0, 2])),
        ...bulkPaths.map((path, index) =>
            writeFile(path, `export const value${index}: number = 2;\n`, 'utf8'),
        ),
        writeFile(join(root, 'vendor/sub/lib/submodule.txt'), 'after\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repoSections = running.page.locator('.git-repository-section');
        await expect(repoSections).toHaveCount(3);
        const primary = repoSections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'project' }),
        });
        const nestedRepo = repoSections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'nested' }),
        });
        const submodule = repoSections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'submodule' }),
        });

        await expect(primary.locator('.git-files')).toContainText('root.txt');
        // The submodule has a repository section of its own below, carrying its branch and its real
        // file changes, so the parent's list drops the gitlink row rather than naming it twice.
        await expect(primary.locator('.git-files')).not.toContainText('sub');
        await expect(primary.locator('.git-files')).not.toContainText('nested.txt');
        await expect(nestedRepo.locator('.git-files')).toContainText('nested.txt');
        await expect(submodule.locator('.git-files')).toContainText('submodule.txt');

        await nestedRepo.locator('.git-repository-row').click();
        await expect(nestedRepo.locator('.git-files')).toHaveCount(0);
        await expect(primary.locator('.git-files')).toContainText('root.txt');
        await expect(submodule.locator('.git-files')).toContainText('submodule.txt');
        await nestedRepo.locator('.git-repository-row').click();
        await nestedRepo.getByRole('treeitem', { name: 'packages', exact: true }).click();
        await expect(nestedRepo.getByRole('treeitem', { name: 'nested.txt' })).toHaveCount(0);
        await nestedRepo.getByRole('treeitem', { name: 'packages', exact: true }).click();
        await nestedRepo.getByRole('treeitem', { name: 'nested.txt' }).click();
        await expect(
            running.page.locator(`${VISIBLE_SESSION} .work-tab`, { hasText: 'nested.txt' }),
        ).toBeVisible();
        await expect(running.page.locator('.monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.monaco-diff-editor')).toContainText('before');
        await expect(running.page.locator('.monaco-diff-editor')).toContainText('after');

        await clickGitGroupAction(nestedRepo, 'Open Changes');
        await expect(
            running.page.locator(`${VISIBLE_SESSION} .work-tab`, { hasText: 'Changes: nested' }),
        ).toBeVisible();
        await expect(running.page.locator('.git-multi-diff')).toBeVisible();
        await expect(running.page.locator('.git-multi-diff-item')).toHaveCount(
            bulkPaths.length + 2,
        );
        await expect(running.page.locator('.git-multi-diff-error')).toHaveCount(1);
        await expect(
            running.page.locator('.git-multi-diff .monaco-diff-editor').first(),
        ).toBeVisible();
        const typescriptDiff = running.page.locator('.git-multi-diff-item').filter({
            has: running.page.getByText('packages/bulk-0.ts', { exact: true }),
        });
        await expect
            .poll(() =>
                typescriptDiff
                    .locator('.view-lines span')
                    .evaluateAll(
                        (spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size,
                    ),
            )
            .toBeGreaterThan(1);
        expect(
            await running.page.locator('.git-multi-diff .monaco-diff-editor').count(),
        ).toBeLessThan(bulkPaths.length + 2);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('canceling Session deletion preserves the dirty editor buffer', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-delete-cancel-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(join(root, 'note.txt'), 'disk state\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('treeitem', { name: 'note.txt', exact: true }).click();
        const editor = running.page.locator(`${VISIBLE_SESSION} .monaco-editor`).first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('unsaved deletion cancel');
        await running.app.evaluate(({ dialog }) => {
            const dialogState = globalThis as typeof globalThis & {
                __caxriDeleteSessionDialogCalls?: number;
            };
            dialogState.__caxriDeleteSessionDialogCalls = 0;
            dialog.showMessageBox = () => {
                dialogState.__caxriDeleteSessionDialogCalls =
                    (dialogState.__caxriDeleteSessionDialogCalls ?? 0) + 1;
                return Promise.resolve({ response: 1, checkboxChecked: false });
            };
        });
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Delete Session', { exact: true }).click();
        await expect
            .poll(() =>
                running.app.evaluate(
                    () =>
                        (
                            globalThis as typeof globalThis & {
                                __caxriDeleteSessionDialogCalls?: number;
                            }
                        ).__caxriDeleteSessionDialogCalls,
                ),
            )
            .toBe(1);

        await expect(running.page.locator('.session-card')).toHaveCount(1);
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'unsaved deletion cancel',
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

test('removing a Project deletes only Caxri metadata', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-remove-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const userFile = join(root, 'keep.txt');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(userFile, 'user-owned\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Delete Project', { exact: true }).click();

        await expect(running.page.locator('.project-group')).toHaveCount(0);
        await expect(running.page.locator('.session-card')).toHaveCount(0);
        await expect.poll(() => readFile(userFile, 'utf8')).toBe('user-owned\n');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('canceling the Agent choice revokes the selected Project root grant', async () => {
    allowE2EErrors([
        {
            source: 'desktop',
            event: 'ipc.request_failed',
            code: 'PATH_DENIED',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-grant-cancel-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await expect(
            running.page.getByRole('heading', { name: 'Choose the default Terminal' }),
        ).toBeVisible();
        await running.page.keyboard.press('Escape');

        const denied = await pageReply(running.page, 'project.create', { rootPath: root });
        expect(denied.ok).toBe(false);
        if (!denied.ok) {
            expect(denied.error.code).toBe('PATH_DENIED');
            expect(denied.error.message).toContain('was not selected');
        }
        await expect(running.page.locator('.session-card')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Keep Running detaches the closed window and reattaches the live Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-keep-running-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        const closed = running.page.waitForEvent('close');
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await closed;
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
            )
            .toBe(0);

        const reopenedPromise = running.app.waitForEvent('window');
        await running.app.evaluate(({ app }) => app.emit('activate'));
        const reopened = await reopenedPromise;
        await waitForRuntimeReady(reopened);
        await expect(
            reopened.locator(`${VISIBLE_SESSION} .terminal-surface[data-terminal-attached="true"]`),
        ).toBeVisible();
        await typeTerminal(reopened, String.raw`printf 'KEEP_RUNNING_OK\n'`);
        await expect(reopened.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'KEEP_RUNNING_OK',
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

test('switching Sessions discards expanded file-tree state from the previous root', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-tree-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const firstRoot = join(testDirectory, 'first-project');
    const secondRoot = join(testDirectory, 'second-project');
    const expandedDirectories = Array.from({ length: 8 }, (_, index) => `expanded-${index}`);
    await execFileAsync('mkdir', [
        '-p',
        secondRoot,
        ...expandedDirectories.map((name) => join(firstRoot, name)),
    ]);
    await Promise.all(
        expandedDirectories.map((name) =>
            writeFile(join(firstRoot, name, 'inside.txt'), 'inside\n', 'utf8'),
        ),
    );
    await writeFile(join(secondRoot, 'second.txt'), 'second\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: firstRoot });
    try {
        await createShellSession(running.page);
        for (const directory of expandedDirectories) {
            // Each click must complete before the next, since expanding one directory changes the
            // tree layout (and thus the position) of subsequent tree items.
            // eslint-disable-next-line no-await-in-loop
            await running.page.getByRole('treeitem', { name: directory, exact: true }).click();
        }
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
        ).toHaveCount(expandedDirectories.length);

        await running.app.evaluate((_, root) => {
            process.env.CAXRI_TEST_ROOT_PATH = root;
        }, secondRoot);
        await openAddProjectDialog(running.page);
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await expect(
            running.page.getByRole('treeitem', { name: 'second.txt', exact: true }),
        ).toBeVisible();

        // The logger now drains writes asynchronously, so first poll for a `file.list` record
        // (emitted while listing the second root above) to prove the log has been flushed to
        // disk, then assert the symlink-rejection message is absent.
        await expect
            .poll(async () => {
                const contents = await readFile(
                    join(userData, 'logs', 'server-core.jsonl'),
                    'utf8',
                );
                return contents.includes('"event":"file.list"');
            })
            .toBe(true);
        expect(await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8')).not.toContain(
            'Symlink target is outside the Project root',
        );
        await expect(running.page.locator('.toast')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('editor buffers stay isolated between Sessions that share one root', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-editor-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(join(root, 'shared.txt'), 'disk state\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('treeitem', { name: 'shared.txt' }).click();
        const editor = running.page.locator(`${VISIBLE_SESSION} .monaco-editor`).first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('first Session dirty buffer');
        const firstSessionId = await selectedSessionId(running.page);

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await running.page.getByRole('treeitem', { name: 'shared.txt' }).click();
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'disk state',
        );
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).not.toContainText(
            'first Session',
        );

        await sessionCard(running.page, firstSessionId).click();
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'first Session dirty buffer',
        );

        await sessionCard(running.page, secondSessionId).click();
        await writeFile(
            join(root, 'shared.txt'),
            'external while first Session inactive\n',
            'utf8',
        );
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'external while first Session inactive',
        );
        await sessionCard(running.page, firstSessionId).click();
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'external while first Session inactive',
        );
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).not.toContainText(
            'first Session dirty buffer',
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
