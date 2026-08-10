import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

test('Bug report preview sends one redacted multiline prompt to the selected live Agent', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-bug-report-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const executable = join(bin, 'claude');
    const capture = join(testDirectory, 'agent-input.bin');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(bin, { recursive: true }),
        writeFile(capture, ''),
    ]);
    await writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs');
const capture = ${JSON.stringify(capture)};
if (process.argv[2] === '--version') {
  process.stdout.write('claude-test 1.0\\n');
  process.exit(0);
}
process.stdout.write('Fake Claude ready\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => fs.appendFileSync(capture, chunk));
setInterval(() => {}, 1000);
`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
    });
    try {
        await createProjectSession(running.page, 'claude');
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
