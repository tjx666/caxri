import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageReply,
    pageRequest,
    runtimeStatus,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    waitForRuntimeReady,
} from './helpers.ts';

const execFileAsync = promisify(execFile);

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
                document.fonts.load('13px "Caxri Nerd Symbols"', '\ue0b0\uf17c'),
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
        await running.app.close().catch(() => undefined);
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
        await running.page.getByRole('button', { name: 'nested', exact: true }).click();
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toBeVisible();
        await writeFile(join(root, 'new.txt'), 'new\n', 'utf8');

        await expect(
            running.page.getByRole('button', { name: 'new.txt', exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toBeVisible();

        await running.page.getByRole('button', { name: 'Collapse Folders' }).click();
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toHaveCount(0);
        await running.page.getByRole('button', { name: 'nested', exact: true }).click();
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
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
        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        const terminalTabs = running.page.locator('.work-tab[data-terminal-id]');
        await expect(terminalTabs).toHaveCount(2);

        const firstTab = terminalTabs.first();
        const close = firstTab.getByRole('button', { name: 'Close Terminal' });
        const widthBeforeHover = await firstTab.evaluate(
            (element) => element.getBoundingClientRect().width,
        );
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
        await expect(running.page.locator('.process-running')).toHaveCount(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('dragging the Sidebar divider resizes it and the width survives a reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-panel-resize-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const sidebar = running.page.locator('.session-sidebar');
        const divider = running.page.getByRole('separator', { name: 'Resize Sidebar' });
        const startWidth = (await sidebar.boundingBox())!.width;
        const dividerBox = (await divider.boundingBox())!;
        const startX = dividerBox.x + dividerBox.width / 2;
        const y = dividerBox.y + dividerBox.height / 2;

        await running.page.mouse.move(startX, y);
        await running.page.mouse.down();
        await running.page.mouse.move(startX + 80, y, { steps: 8 });
        await running.page.mouse.up();

        await expect
            .poll(async () => (await sidebar.boundingBox())?.width)
            .toBeGreaterThan(startWidth + 60);
        const widthAfterDrag = Math.round((await sidebar.boundingBox())!.width);

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect
            .poll(async () =>
                Math.round((await running.page.locator('.session-sidebar').boundingBox())!.width),
            )
            .toBe(widthAfterDrag);

        // Double-click resets to the default width shipped with `.app-shell` in styles.css.
        await running.page.getByRole('separator', { name: 'Resize Sidebar' }).dblclick();
        await expect
            .poll(async () => (await running.page.locator('.session-sidebar').boundingBox())?.width)
            .toBe(230);

        // The status-bar toggle (previously a dead icon) collapses the Inspector and its divider.
        const inspectorToggle = running.page.getByRole('button', { name: 'Hide Inspector' });
        await expect(running.page.locator('.inspector')).toBeVisible();
        await inspectorToggle.click();
        await expect(running.page.locator('.inspector')).toHaveCount(0);
        await expect(running.page.getByRole('separator', { name: 'Resize Inspector' })).toHaveCount(
            0,
        );
        await running.page.getByRole('button', { name: 'Show Inspector' }).click();
        await expect(running.page.locator('.inspector')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('sidebar search finds and selects Projects instead of exporting diagnostics', async () => {
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
        await running.page.getByRole('button', { name: 'Add Project' }).first().click();
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
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Info inspector lists only the current Session Terminals', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-multi-agent-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
        await expect(
            running.page.getByRole('heading', { name: 'Choose the default Terminal' }),
        ).toBeVisible();
        await running.page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();
        await expect(running.page.locator('.session-card')).toHaveCount(1);

        await running.page.getByRole('button', { name: 'Info', exact: true }).click();
        const terminalCards = running.page.locator('.terminal-info-card');
        await expect(terminalCards).toHaveCount(1);
        await expect(terminalCards.filter({ hasText: 'Codex' })).toBeVisible();
        await expect(terminalCards.filter({ hasText: 'Claude Code' })).toHaveCount(0);

        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        await expect(terminalCards).toHaveCount(2);
        await expect(terminalCards.filter({ hasText: 'Shell' })).toBeVisible();
        await expect(terminalCards.locator('[data-agent-icon="codex"]')).toBeVisible();
        await expect(terminalCards.locator('[data-agent-icon="shell"]')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Project Status inspector renders and refreshes the current repository tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-status-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'feature/status'], { cwd: root });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click({ timeout: 5_000 })
            .catch(() => undefined);
        await expect(running.page.locator('.session-card')).toHaveCount(1);
        await running.page.getByRole('button', { name: 'Status', exact: true }).click();

        await expect(running.page.getByText('Project Status', { exact: true })).toBeVisible();
        const repository = running.page.locator('.project-status-repository');
        await expect(repository).toHaveCount(1);
        await expect(repository).toContainText('project');
        await expect(repository).toContainText('feature/status');

        await repository.locator('.project-status-repository-row').click();
        await expect(repository.getByText('feature/status', { exact: true })).toHaveCount(0);
        await repository.locator('.project-status-repository-row').click();
        await running.page.getByRole('button', { name: 'Refresh Project Status' }).click();
        await expect(repository.getByText('feature/status', { exact: true })).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Git inspector shows child repositories, submodule state, and changed-file trees', async () => {
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
    for (const repository of [root, nested, submoduleSource]) {
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
        await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], {
            cwd: repository,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: repository });
    }
    await writeFile(join(root, 'src/root.txt'), 'before\n', 'utf8');
    await execFileAsync('git', ['add', 'src/root.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(nested, 'packages/nested.txt'), 'before\n', 'utf8');
    await writeFile(join(nested, 'assets/binary.bin'), Buffer.from([0, 1]));
    await Promise.all(bulkPaths.map((path) => writeFile(path, 'before\n', 'utf8')));
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
        ...bulkPaths.map((path) => writeFile(path, 'after\n', 'utf8')),
        writeFile(join(root, 'vendor/sub/lib/submodule.txt'), 'after\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('button', { name: 'Git', exact: true }).click();
        const repositorySections = running.page.locator('.git-repository-section');
        await expect(repositorySections).toHaveCount(3);
        const primary = repositorySections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'project' }),
        });
        const nestedRepository = repositorySections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'nested' }),
        });
        const submodule = repositorySections.filter({
            has: running.page.locator('.git-repository-row', { hasText: 'submodule' }),
        });

        await expect(primary.locator('.git-files')).toContainText('root.txt');
        await expect(primary.locator('.git-files')).toContainText('sub');
        await expect(primary.locator('.git-files')).not.toContainText('nested.txt');
        await expect(nestedRepository.locator('.git-files')).toContainText('nested.txt');
        await expect(submodule.locator('.git-files')).toContainText('submodule.txt');

        await nestedRepository.locator('.git-repository-row').click();
        await expect(nestedRepository.locator('.git-files')).toHaveCount(0);
        await expect(primary.locator('.git-files')).toContainText('root.txt');
        await expect(submodule.locator('.git-files')).toContainText('submodule.txt');
        await nestedRepository.locator('.git-repository-row').click();
        await nestedRepository.getByRole('button', { name: 'packages', exact: true }).click();
        await expect(nestedRepository.getByRole('button', { name: 'nested.txt' })).toHaveCount(0);
        await nestedRepository.getByRole('button', { name: 'packages', exact: true }).click();
        await nestedRepository.getByRole('button', { name: 'nested.txt' }).click();
        await expect(running.page.locator('.work-tab', { hasText: 'nested.txt' })).toBeVisible();
        await expect(running.page.locator('.monaco-diff-editor')).toBeVisible();
        await expect(running.page.locator('.monaco-diff-editor')).toContainText('before');
        await expect(running.page.locator('.monaco-diff-editor')).toContainText('after');

        await nestedRepository.getByRole('button', { name: 'Open Changes' }).click();
        await expect(
            running.page.locator('.work-tab', { hasText: 'Changes: nested' }),
        ).toBeVisible();
        await expect(running.page.locator('.git-multi-diff')).toBeVisible();
        await expect(running.page.locator('.git-multi-diff-item')).toHaveCount(
            bulkPaths.length + 2,
        );
        await expect(running.page.locator('.git-multi-diff-error')).toHaveCount(1);
        await expect(
            running.page.locator('.git-multi-diff .monaco-diff-editor').first(),
        ).toBeVisible();
        expect(
            await running.page.locator('.git-multi-diff .monaco-diff-editor').count(),
        ).toBeLessThan(bulkPaths.length + 2);
    } finally {
        await running.app.close().catch(() => undefined);
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
        await running.page.getByRole('button', { name: 'note.txt', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('unsaved deletion cancel');
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
        });
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page.getByText('Delete Session', { exact: true }).click();
        await running.page.waitForTimeout(300);

        await expect(running.page.locator('.session-card')).toHaveCount(1);
        await expect(running.page.locator('.view-lines')).toContainText('unsaved deletion cancel');
    } finally {
        await running.app.close().catch(() => undefined);
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
        await running.page.getByText('Remove Project', { exact: true }).click();

        await expect(running.page.locator('.project-group')).toHaveCount(0);
        await expect(running.page.locator('.session-card')).toHaveCount(0);
        await expect.poll(() => readFile(userFile, 'utf8')).toBe('user-owned\n');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('canceling the Agent choice revokes the selected Project root grant', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-grant-cancel-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
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
        await running.app.close().catch(() => undefined);
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

        const reopenedPromise = running.app.waitForEvent('window');
        await running.app.evaluate(({ app }) => app.emit('activate'));
        const reopened = await reopenedPromise;
        await waitForRuntimeReady(reopened);
        await expect(reopened.locator('.process-running').first()).toBeVisible();
        await typeTerminal(reopened, "printf 'KEEP_RUNNING_OK\\n'");
        await expect(reopened.locator('.xterm-rows')).toContainText('KEEP_RUNNING_OK');
    } finally {
        await running.app.close().catch(() => undefined);
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
            await running.page.getByRole('button', { name: directory, exact: true }).click();
        }
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toHaveCount(expandedDirectories.length);

        await running.app.evaluate((_, root) => {
            process.env.CAXRI_TEST_ROOT_PATH = root;
        }, secondRoot);
        await running.page.getByRole('button', { name: 'Add Project' }).first().click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await expect(
            running.page.getByRole('button', { name: 'second.txt', exact: true }),
        ).toBeVisible();

        expect(await readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8')).not.toContain(
            'Symlink target is outside the Project root',
        );
        await expect(running.page.locator('.toast')).toHaveCount(0);
    } finally {
        await running.app.close().catch(() => undefined);
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
        await running.page.getByRole('button', { name: 'shared.txt' }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('first Session dirty buffer');
        const firstSessionId = await selectedSessionId(running.page);

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await running.page.getByRole('button', { name: 'shared.txt' }).click();
        await expect(running.page.locator('.view-lines')).toContainText('disk state');
        await expect(running.page.locator('.view-lines')).not.toContainText('first Session');

        await sessionCard(running.page, firstSessionId).click();
        await expect(running.page.locator('.view-lines')).toContainText(
            'first Session dirty buffer',
        );

        await sessionCard(running.page, secondSessionId).click();
        await writeFile(
            join(root, 'shared.txt'),
            'external while first Session inactive\n',
            'utf8',
        );
        await expect(running.page.locator('.view-lines')).toContainText(
            'external while first Session inactive',
        );
        await sessionCard(running.page, firstSessionId).click();
        await expect(running.page.locator('.view-lines')).toContainText(
            'external while first Session inactive',
        );
        await expect(running.page.locator('.view-lines')).not.toContainText(
            'first Session dirty buffer',
        );
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('complete local workbench workflow, recovery, privacy, and persistence', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const sessionRoot = join(testDirectory, 'project');
    const diagnosticsPath = join(testDirectory, 'diagnostics.zip');
    await execFileAsync('mkdir', ['-p', sessionRoot]);
    await writeFile(join(sessionRoot, 'note.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: sessionRoot });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: sessionRoot });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: sessionRoot });
    await execFileAsync('git', ['add', 'note.txt'], { cwd: sessionRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: sessionRoot });

    let running = await launchCaxri({ userDataDir: userData, testRootPath: sessionRoot });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await typeTerminal(running.page, "printf 'CAXRI_E2E_OK\\n'");
        await expect(running.page.locator('.xterm-rows')).toContainText('CAXRI_E2E_OK');

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await expect(running.page.locator('.session-card')).toHaveCount(2);

        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await typeTerminal(running.page, "sleep 1; printf 'BACKGROUND_CONTINUED\\n'");
        await secondSession.click();
        await expect(secondSession).toHaveClass(/active/);
        await running.page.waitForTimeout(1_400);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await expect(running.page.locator('.xterm-rows')).toContainText('BACKGROUND_CONTINUED');

        await running.page.getByRole('button', { name: 'note.txt' }).click();
        await expect(running.page.locator('.monaco-editor')).toBeVisible();
        const editorSurface = running.page.locator('.monaco-editor').first();
        await editorSurface.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('saved by Caxri');
        await running.page.keyboard.press('Meta+S');
        await expect
            .poll(() => readFile(join(sessionRoot, 'note.txt'), 'utf8'))
            .toContain('saved by Caxri');

        await editorSurface.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('dirty local buffer');
        await writeFile(join(sessionRoot, 'note.txt'), 'external wins\n', 'utf8');
        await expect(
            running.page.getByText(/reloaded from disk; external changes take precedence/),
        ).toBeVisible();
        await expect(running.page.locator('.view-lines')).toContainText('external wins');

        await running.page.getByRole('button', { name: 'Git', exact: true }).click();
        await expect(running.page.getByText('main', { exact: false })).toBeVisible();
        await expect(
            running.page.locator('.git-files .git-row', { hasText: 'note.txt' }),
        ).toBeVisible();
        const infoTab = running.page.getByRole('button', { name: 'Info', exact: true });
        await infoTab.click();
        await expect(infoTab).toHaveClass(/active/);
        await expect(running.page.locator('.terminal-info-card')).not.toHaveCount(0);

        await running.page.keyboard.press('Meta+,');
        await running.page.getByRole('button', { name: 'Theme', exact: true }).click();
        await expect(running.page.getByText('Dracula', { exact: true })).toBeVisible();
        await expect(
            running.page.getByLabel('theme.json source').locator('.view-lines'),
        ).toContainText('#282a36');
        const terminalTabCount = await running.page.locator('.work-tab').count();
        await running.page.keyboard.press('Meta+W');
        await expect(running.page.getByRole('dialog')).toBeVisible();
        await expect(running.page.locator('.work-tab')).toHaveCount(terminalTabCount);
        await running.page.getByRole('button', { name: 'Close' }).click();

        await running.app.evaluate(({ dialog }, path) => {
            dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
        }, diagnosticsPath);
        await pageRequest(running.page, 'diagnostics.export');
        const { stdout: archiveList } = await execFileAsync('unzip', ['-l', diagnosticsPath]);
        expect(archiveList).not.toContain('snapshot');
        expect(archiveList).not.toContain('scrollback');
        const { stdout: archiveText } = await execFileAsync('unzip', ['-p', diagnosticsPath]);
        expect(archiveText).not.toContain('external wins');
        expect(archiveText).not.toContain('CAXRI_E2E_OK');

        await running.page
            .locator('.work-tab [role="tab"]')
            .filter({ hasText: 'Shell' })
            .first()
            .click();
        await typeTerminal(running.page, "sleep 1; printf 'AFTER_RENDERER_RELOAD\\n'");
        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(running.page.locator('.xterm-rows')).toContainText('AFTER_RENDERER_RELOAD');

        await running.app.evaluate(({ app }) => {
            const runtime = app.getAppMetrics().find((metric) => metric.name === 'Caxri Runtime');
            if (!runtime) throw new Error('Runtime utility process not found');
            process.kill(runtime.pid, 'SIGKILL');
        });
        await expect(runtimeStatus(running.page)).toHaveAttribute(
            'data-runtime-status',
            'restarting',
        );
        await waitForRuntimeReady(running.page);
        await expect(
            running.page.getByRole('button', { name: /Restart Terminal/ }).first(),
        ).toBeVisible();
        const deadTerminalId = await running.page
            .locator('.terminal-pane')
            .first()
            .getAttribute('data-terminal-id');
        if (!deadTerminalId) throw new Error('Dead Terminal ID was not rendered');
        await pageRequest(running.page, 'terminal.input', {
            terminalId: deadTerminalId,
            data: 'ignored stale input',
        });
        await pageRequest(running.page, 'terminal.resize', {
            terminalId: deadTerminalId,
            cols: 120,
            rows: 40,
        });
        await running.page.locator('.terminal-surface').first().click();
        await running.page.keyboard.insertText('ignored dead Terminal input');
        await expect(running.page.locator('.toast')).toHaveCount(0);
        await running.page
            .getByRole('button', { name: /Restart Terminal/ })
            .first()
            .click();
        await expect(running.page.locator('.process-running').first()).toBeVisible();
        await typeTerminal(running.page, "printf 'AFTER_RUNTIME_RESTART\\n'");
        await expect(running.page.locator('.xterm-rows').first()).toContainText(
            'AFTER_RUNTIME_RESTART',
        );

        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1180, height: 760 }),
        );
        await running.page.waitForTimeout(400);
        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: sessionRoot });
        await expect(running.page.locator('.project-group')).toHaveCount(1);
        await expect(running.page.locator('.project-group.active .session-card')).toHaveCount(2);
        await expect(running.page.locator('.session-card')).toHaveCount(2);
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]?.getBounds(),
                ),
            )
            .toMatchObject({ width: 1180, height: 760 });
        await expect(
            running.page.getByRole('button', { name: /Restart Terminal/ }).first(),
        ).toBeVisible();
        await running.page
            .getByRole('button', { name: /Restart Terminal/ })
            .first()
            .click();
        await expect(running.page.locator('.process-running').first()).toBeVisible();

        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 2, checkboxChecked: false });
        });
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await waitForRuntimeReady(running.page);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
