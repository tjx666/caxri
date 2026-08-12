import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './fixtures.ts';

import { createFakeAgentMode } from './agent-fixture.ts';
import { createProjectSession, launchCaxri } from './helpers.ts';

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
        await dialog
            .getByLabel('Capture a screenshot of the current Caxri window for preview')
            .check();
        await dialog.getByRole('button', { name: 'Preview Report' }).click();

        const preview = dialog.locator('pre');
        await expect(preview).toContainText('# Caxri Bug Report');
        await expect(preview).toContainText('token=[REDACTED]');
        await expect(preview).not.toContainText('private-value');
        await expect(dialog.getByAltText('Current Caxri window screenshot')).toBeVisible();
        await expect(dialog).toContainText('Screenshot capture is preview-only.');
        await expect(dialog.getByLabel('Target Agent')).toContainText('Claude Code');

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(running.page.getByText(/Bug report sent to/)).toBeVisible();

        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u001B[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\u001B[200~# Caxri Bug Report')).toBe(true);
        expect(agentInput).toContain('The action failed with token=[REDACTED]');
        expect(agentInput).toContain('1. Open Caxri\n2. Run the action\n3. Observe the failure');
        expect(agentInput).not.toContain('private-value');
        expect(agentInput.split('\u001B[200~')).toHaveLength(2);
        expect(agentInput.split('\u001B[201~')).toHaveLength(2);
    } finally {
        await running.app.close().catch(() => undefined);
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
        await dialog
            .getByLabel('Capture a screenshot of the current Caxri window for preview')
            .check();
        await expect(dialog).toContainText('Sending replaces the system clipboard');
        await dialog.getByRole('button', { name: 'Preview Report' }).click();
        await expect(dialog.getByAltText('Current Caxri window screenshot')).toBeVisible();

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()))
            .toBe(true);
        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u001B[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\x16\u001B[200~# Caxri Bug Report')).toBe(true);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
