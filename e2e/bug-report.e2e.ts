import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * The opt-in checkbox and the preview's `alt` text both have to say that a screenshot, unlike the
 * text report, is captured pixel-for-pixel and cannot be redacted. Pinned here as constants so a
 * future copy edit that quietly drops the disclosure fails this spec instead of passing silently.
 */
const SCREENSHOT_CHECKBOX_LABEL =
    'Capture a screenshot of the current Caxri window, including any open files and terminal output visible on screen';
const SCREENSHOT_PREVIEW_ALT =
    'Unredacted screenshot of the current Caxri window, including any open files and terminal output';

test('Bug report preview sends one redacted multiline prompt to the selected live Agent', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-bug-report-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.bin');
    await Promise.all([mkdir(root, { recursive: true }), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                inputCapture: { path: capture, encoding: 'raw' },
                readinessDelayMs:
                    process.env.CAXRI_CI_PARITY_CASE === 'late-raw-mode' ? 750 : undefined,
                startupOutput: 'FAKE_CLAUDE_INPUT_READY\r\n',
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText('FAKE_CLAUDE_INPUT_READY');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('report bug');
        await palette.getByText('Report Bug to Agent', { exact: true }).click();

        const dialog = running.page.getByRole('dialog');
        await dialog
            .getByLabel('Actual behavior')
            .fill('The action failed with token=private-value.');
        await dialog.getByLabel('Expected behavior').fill('The action should finish once.');
        await dialog
            .getByLabel('Reproduction steps')
            .fill('1. Open Caxri\n2. Run the action\n3. Observe the failure');
        await dialog.getByLabel(SCREENSHOT_CHECKBOX_LABEL).check();
        // Opting in must immediately admit that the screenshot is the one part of the report that
        // is *not* redacted; the assertions below prove the text half still is.
        await expect(dialog).toContainText(
            'Unlike the text report, this screenshot is not redacted',
        );
        await dialog.getByRole('button', { name: 'Preview Report' }).click();

        const preview = dialog.locator('pre');
        await expect(preview).toContainText('# Caxri Bug Report');
        await expect(preview).toContainText('token=[REDACTED]');
        await expect(preview).not.toContainText('private-value');
        await expect(dialog.getByAltText(SCREENSHOT_PREVIEW_ALT)).toBeVisible();
        await expect(dialog).toContainText('This screenshot is unredacted');
        await expect(dialog).toContainText('Screenshot capture is preview-only.');
        await expect(dialog.getByLabel('Target Agent')).toContainText('Claude Code');

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(running.page.getByText(/Bug report sent to/)).toBeVisible();

        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u{1B}[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\u{1B}[200~# Caxri Bug Report')).toBe(true);
        expect(agentInput).toContain('The action failed with token=[REDACTED]');
        expect(agentInput).toContain('1. Open Caxri\n2. Run the action\n3. Observe the failure');
        expect(agentInput).not.toContain('private-value');
        expect(agentInput.split('\u{1B}[200~')).toHaveLength(2);
        expect(agentInput.split('\u{1B}[201~')).toHaveLength(2);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Bug report delivers an opted-in screenshot through Codex image paste', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-bug-report-codex-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.bin');
    await Promise.all([mkdir(root), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                inputCapture: { path: capture, encoding: 'raw' },
                startupOutput: 'FAKE_CODEX_INPUT_READY\r\n',
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('FAKE_CODEX_INPUT_READY');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('report bug');
        await palette.getByText('Report Bug to Agent', { exact: true }).click();

        const dialog = running.page.getByRole('dialog');
        await dialog.getByLabel('Actual behavior').fill('The preview is stale.');
        await dialog.getByLabel('Expected behavior').fill('The preview should refresh.');
        await dialog.getByLabel('Reproduction steps').fill('1. Open preview\n2. Refresh');
        await dialog.getByLabel(SCREENSHOT_CHECKBOX_LABEL).check();
        await expect(dialog).toContainText('Sending replaces the system clipboard');
        await dialog.getByRole('button', { name: 'Preview Report' }).click();
        await expect(dialog.getByAltText(SCREENSHOT_PREVIEW_ALT)).toBeVisible();

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()))
            .toBe(true);
        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u{1B}[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\u{16}\u{1B}[200~# Caxri Bug Report')).toBe(true);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
