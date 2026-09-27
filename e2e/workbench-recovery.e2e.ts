import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    openPanelView,
    openSettingsTab,
    pageRequest,
    runtimeStatus,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    VISIBLE_SESSION,
    waitForRuntimeReady,
} from './support/helpers.ts';

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
        await typeTerminal(running.page, String.raw`printf 'CAXRI_E2E_OK\n'`);
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'CAXRI_E2E_OK',
        );

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await expect(running.page.locator('.session-card')).toHaveCount(2);

        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await typeTerminal(running.page, String.raw`sleep 1; printf 'BACKGROUND_CONTINUED\n'`);
        await secondSession.click();
        await expect(secondSession).toHaveClass(/active/);
        await running.page.waitForTimeout(1_400);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'BACKGROUND_CONTINUED',
        );

        await running.page.getByRole('treeitem', { name: 'note.txt' }).click();
        await expect(running.page.locator(`${VISIBLE_SESSION} .monaco-editor`)).toBeVisible();
        const editorSurface = running.page.locator(`${VISIBLE_SESSION} .monaco-editor`).first();
        await editorSurface.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('saved by Caxri');
        await running.page.keyboard.press('Meta+S');
        await expect
            .poll(() => readFile(join(sessionRoot, 'note.txt'), 'utf8'))
            .toContain('saved by Caxri');
        const editorTab = running.page.getByRole('tab', { name: 'note.txt', exact: true });
        // The tab description now carries the Git state alongside the unsaved state (`work-tab.tsx`), and this file is
        // modified inside a repository, so the attribute's mere presence no longer says anything about the buffer.
        // Assert the unsaved half by text instead; the span is absent entirely while the description is empty.
        const editorTabDescription = running.page
            .locator('.work-tab', { has: editorTab })
            .locator('span[id$="-description"]');
        await expect(editorTabDescription).not.toContainText('Unsaved changes.');

        const externalReloadNotice = running.page.getByText(
            /reloaded from disk; external changes take precedence/,
        );
        await writeFile(join(sessionRoot, 'note.txt'), 'clean external change\n', 'utf8');
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'clean external change',
        );
        await expect(externalReloadNotice).not.toBeVisible();

        await editorSurface.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('dirty local buffer');
        await expect(editorTabDescription).toContainText('Unsaved changes.');
        await writeFile(join(sessionRoot, 'note.txt'), 'external wins\n', 'utf8');
        await expect(externalReloadNotice).toBeVisible();
        await expect(running.page.locator(`${VISIBLE_SESSION} .view-lines`)).toContainText(
            'external wins',
        );
        await expect(editorTabDescription).not.toContainText('Unsaved changes.');

        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const sourceControlText = running.page
            .locator('.git-panel')
            .getByText('main', { exact: false });
        await expect(sourceControlText).toBeVisible();
        await expect(
            running.page.locator('.git-files .git-row', { hasText: 'note.txt' }),
        ).toBeVisible();
        const infoTab = await openPanelView(running.page, 'Info');
        await expect(infoTab).toHaveClass(/active/);
        await expect(running.page.locator('.terminal-info-card')).not.toHaveCount(0);

        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(running.page.getByText('Dracula', { exact: true })).toBeVisible();
        await running.page.getByRole('button', { name: 'Source' }).click();
        // Scoped by `data-config-source`, not by accessible name: `ConfigurationEditor` passes the
        // label through Monaco's `options.ariaLabel` so it lands on the textarea a screen reader
        // actually focuses. `.view-lines` is that textarea's sibling, so `getByLabel(...)` can never
        // contain it. The accessible name itself is asserted separately in `settings.e2e.ts`.
        await expect(
            running.page.locator('[data-config-source="theme"] .view-lines'),
        ).toContainText('#282a36');
        const tabCountWithSettings = await running.page
            .locator(`${VISIBLE_SESSION} .work-tab`)
            .count();
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes the
        // active tab exactly like it would for any other document, which here is the Settings tab
        // itself, one fewer `.work-tab` than before — not the Terminal or editor tab underneath it,
        // the way the old modal-swallowed shortcut used to prove by changing nothing at all.
        await running.page.keyboard.press('Meta+W');
        await expect(settingsTab).toHaveCount(0);
        await expect(running.page.locator(`${VISIBLE_SESSION} .work-tab`)).toHaveCount(
            tabCountWithSettings - 1,
        );

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
            .locator(`${VISIBLE_SESSION} .work-tab [role="tab"]`)
            .filter({ hasText: 'Shell' })
            .first()
            .click();
        const activeTerminalId = await running.page
            .locator(`${VISIBLE_SESSION} .work-tab.active[data-terminal-id]`)
            .getAttribute('data-terminal-id');
        if (!activeTerminalId) throw new Error('Active Shell Terminal ID was not rendered');
        await typeTerminal(running.page, String.raw`sleep 1; printf 'AFTER_RENDERER_RELOAD\n'`);
        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'AFTER_RENDERER_RELOAD',
        );

        await typeTerminal(running.page, String.raw`printf 'STALE_RENDERER_ONLY\n'`);
        await expect(running.page.locator(`${VISIBLE_SESSION} .xterm-rows`)).toContainText(
            'STALE_RENDERER_ONLY',
        );
        const serverStatus = await pageRequest<{ pid: number }>(running.page, 'host.status');
        process.kill(serverStatus.pid, 'SIGKILL');
        await expect(runtimeStatus(running.page)).toHaveAttribute(
            'data-runtime-status',
            'restarting',
        );
        await waitForRuntimeReady(running.page);
        // Terminals killed with Server Core are marked interrupted and auto-restored for the
        // selected Session without a manual Restart click (GitHub issue #18). The mounted xterm is
        // replaced from the durable snapshot, so output that existed only in the dead
        // Renderer/Core generation cannot linger on screen (GitHub issue #67).
        // Runtime readiness precedes the selected Shell's automatic PTY restore. Waiting on the old
        // Session activity spinner only hid that ordering; use the Terminal's owning process state.
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    terminals: Array<{ id: string; lastProcessState: string }>;
                }>(running.page, 'app.bootstrap');
                return state.terminals.find((terminal) => terminal.id === activeTerminalId)
                    ?.lastProcessState;
            })
            .toBe('running');
        const restoredRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${activeTerminalId}"] .xterm-rows`,
        );
        await expect(restoredRows).not.toContainText('STALE_RENDERER_ONLY');
        await expect(
            running.page.locator(
                `.terminal-info-card[data-terminal-info-id="${activeTerminalId}"] .terminal-state-running`,
            ),
        ).toBeVisible();
        const restoredInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${activeTerminalId}"] .xterm-helper-textarea`,
        );
        await restoredInput.focus();
        await expect(restoredInput).toBeFocused();
        await restoredInput.pressSequentially(String.raw`printf 'AFTER_RUNTIME_RESTART\n'`);
        await restoredInput.press('Enter');
        await expect(restoredRows).toContainText('AFTER_RUNTIME_RESTART');

        // Must differ from the 1440x900 default AND fit the CI display: the macos-26-arm64
        // runner's work area is only 1024x677 and macOS clamps larger setBounds calls to it.
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.setBounds({ width: 960, height: 640 }),
        );
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
            .toMatchObject({ width: 960, height: 640 });
        // An orderly app quit also leaves running Terminals interrupted; the relaunched Runtime
        // restores the selected Session's Terminals on startup without user action.
        await expect(
            running.page.locator(
                `${VISIBLE_SESSION} .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();

        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 2, checkboxChecked: false });
        });
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await waitForRuntimeReady(running.page);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
