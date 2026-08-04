import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');

async function launch(
    userData: string,
    sessionRoot: string,
): Promise<{ app: ElectronApplication; page: Page }> {
    const electronApp = await electron.launch({
        args: ['.', '--disable-gpu'],
        cwd: projectRoot,
        env: {
            ...process.env,
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: userData,
            CAXRI_TEST_ROOT_PATH: sessionRoot,
        },
    });
    const page = await electronApp.firstWindow();
    await expect(page.getByText('Runtime ready')).toBeVisible();
    return { app: electronApp, page };
}

async function createShellSession(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Create Session', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(page.locator('.session-card')).toHaveCount(1);
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
}

async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

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

    const running = await launch(userData, firstRoot);
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
        await running.page.getByRole('button', { name: 'Create Session' }).first().click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await expect(
            running.page.getByRole('button', { name: 'second.txt', exact: true }),
        ).toBeVisible();

        expect(await readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8')).not.toContain(
            'Symlink target is outside the Session root',
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

    const running = await launch(userData, root);
    try {
        await createShellSession(running.page);
        await running.page.getByRole('button', { name: 'shared.txt' }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('first Session dirty buffer');

        await running.page.getByRole('button', { name: 'Create Session' }).first().click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await running.page.getByRole('button', { name: 'shared.txt' }).click();
        await expect(running.page.locator('.view-lines')).toContainText('disk state');
        await expect(running.page.locator('.view-lines')).not.toContainText('first Session');

        await running.page.locator('.session-card').first().click();
        await expect(running.page.locator('.view-lines')).toContainText(
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

    let running = await launch(userData, sessionRoot);
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, "printf 'CAXRI_E2E_OK\\n'");
        await expect(running.page.locator('.xterm-rows')).toContainText('CAXRI_E2E_OK');

        await running.page.getByRole('button', { name: 'Create Session' }).first().click();
        await running.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true })
            .click();
        await expect(running.page.locator('.session-card')).toHaveCount(2);

        const firstSession = running.page.locator('.session-card').first();
        const secondSession = running.page.locator('.session-card').nth(1);
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
        const agentTab = running.page.getByRole('button', { name: 'Agent', exact: true });
        await agentTab.click();
        await expect(agentTab).toHaveClass(/active/);
        await expect(running.page.getByText('unknown', { exact: true }).first()).toBeVisible();

        await running.page.getByRole('button', { name: 'Settings' }).click();
        await running.page.getByRole('button', { name: 'Theme', exact: true }).click();
        await expect(running.page.getByText('Dracula', { exact: true })).toBeVisible();
        await expect(running.page.locator('textarea[aria-label="theme.json source"]')).toHaveValue(
            /#282a36/,
        );
        await running.page.getByRole('button', { name: 'Close' }).click();

        await running.app.evaluate(({ dialog }, path) => {
            dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
        }, diagnosticsPath);
        await running.page.evaluate(async () => {
            const bridge = (
                window as unknown as { caxri: { request(method: string): Promise<unknown> } }
            ).caxri;
            await bridge.request('diagnostics.export');
        });
        const { stdout: archiveList } = await execFileAsync('unzip', ['-l', diagnosticsPath]);
        expect(archiveList).not.toContain('snapshot');
        expect(archiveList).not.toContain('scrollback');
        const { stdout: archiveText } = await execFileAsync('unzip', ['-p', diagnosticsPath]);
        expect(archiveText).not.toContain('external wins');
        expect(archiveText).not.toContain('CAXRI_E2E_OK');

        await running.page
            .locator('.work-tabs > button')
            .filter({ hasText: 'Shell' })
            .first()
            .click();
        await typeTerminal(running.page, "sleep 1; printf 'AFTER_RENDERER_RELOAD\\n'");
        await running.page.reload();
        await expect(running.page.getByText('Runtime ready')).toBeVisible();
        await expect(running.page.locator('.xterm-rows')).toContainText('AFTER_RENDERER_RELOAD');

        await running.app.evaluate(({ app }) => {
            const runtime = app.getAppMetrics().find((metric) => metric.name === 'Caxri Runtime');
            if (!runtime) throw new Error('Runtime utility process not found');
            process.kill(runtime.pid, 'SIGKILL');
        });
        await expect(running.page.getByText('Runtime restarting')).toBeVisible();
        await expect(running.page.getByText('Runtime ready')).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: /Restart Terminal/ }).first(),
        ).toBeVisible();
        const deadTerminalId = await running.page
            .locator('.terminal-pane')
            .first()
            .getAttribute('data-terminal-id');
        if (!deadTerminalId) throw new Error('Dead Terminal ID was not rendered');
        await running.page.evaluate(async (terminalId) => {
            const bridge = (
                window as unknown as {
                    caxri: { request(method: string, params: unknown): Promise<unknown> };
                }
            ).caxri;
            await bridge.request('terminal.input', { terminalId, data: 'ignored stale input' });
            await bridge.request('terminal.resize', { terminalId, cols: 120, rows: 40 });
        }, deadTerminalId);
        await running.page.locator('.terminal-surface').first().click();
        await running.page.keyboard.insertText('ignored dead Terminal input');
        await expect(running.page.locator('.toast')).toHaveCount(0);
        await running.page
            .getByRole('button', { name: /Restart Terminal/ })
            .first()
            .click();
        await expect(running.page.locator('.xterm-helper-textarea')).toBeVisible();

        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1180, height: 760 }),
        );
        await running.page.waitForTimeout(400);
        await running.app.close();
        running = await launch(userData, sessionRoot);
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
        await expect(running.page.locator('.xterm-helper-textarea')).toBeVisible();

        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 2, checkboxChecked: false });
        });
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await expect(running.page.getByText('Runtime ready')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
