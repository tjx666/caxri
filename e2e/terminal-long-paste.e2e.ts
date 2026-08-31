import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('long Agent paste saves the original and inserts only a low-cost summary and path', async ({}) => {
    allowE2EErrors([
        {
            source: 'server-core',
            event: 'ipc.request_failed',
            code: 'CONFLICT',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-long-paste-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const inputCapture = join(testDirectory, 'agent-input.txt');
    const summaryCapture = join(testDirectory, 'summary-call.json');
    await Promise.all([mkdir(root, { recursive: true }), writeFile(inputCapture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv.includes('--ephemeral')) {
  let inputLength = 0;
  process.stdin.on('data', (chunk) => { inputLength += chunk.length; });
  process.stdin.on('end', () => {
    const modelIndex = process.argv.indexOf('-m');
    fs.writeFileSync(${JSON.stringify(summaryCapture)}, JSON.stringify({
      inputLength,
      model: process.argv[modelIndex + 1],
    }));
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'E2E_SUMMARY_SENTINEL' },
      }) + '\n');
    }, 1000);
  });
} else {
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(inputCapture)}, chunk));
  process.stdin.resume();
  process.stdout.write('\u001b[?2004hLONG_PASTE_AGENT_READY\r\n');
}
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });

    try {
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        expect(currentSettings.value['terminal.longPasteThreshold']).toBe(1_024);
        expect(currentSettings.value['agents.providers'].codex.pasteSummary.enabled).toBe(true);

        const sessionId = await createProjectSession(running.page, 'codex');
        const initialState = await pageRequest<{
            terminals: Array<{ id: string; sessionId: string }>;
        }>(running.page, 'app.bootstrap');
        const firstTerminal = initialState.terminals.find(
            (terminal) => terminal.sessionId === sessionId,
        );
        expect(firstTerminal).toBeDefined();
        const secondTerminal = await pageRequest<{ id: string }>(running.page, 'terminal.create', {
            sessionId,
            kind: 'codex',
        });
        const firstTab = running.page.locator(
            `.work-tab[data-terminal-id="${firstTerminal!.id}"] [role="tab"]`,
        );
        const secondTab = running.page.locator(
            `.work-tab[data-terminal-id="${secondTerminal.id}"] [role="tab"]`,
        );
        await expect(secondTab).toBeVisible();
        await firstTab.click();
        const rows = running.page.locator('.xterm-rows');
        const input = running.page.locator('.xterm-helper-textarea');
        await expect(rows).toContainText('LONG_PASTE_AGENT_READY');
        const original = `LONG_PASTE_ORIGINAL_SENTINEL\n${'x'.repeat(1_100)}`;
        await running.clipboard.writeText(original);
        await input.focus();
        await input.press('Meta+V');

        const status = running.page
            .locator('.terminal-pane [role="status"]')
            .filter({ hasText: 'Summarizing pasted text…' });
        await expect(status).toBeVisible();
        await expect(status).toBeHidden();
        await expect.poll(async () => (await stat(inputCapture)).size).toBeGreaterThan(0);
        await expect
            .poll(async () => (await readFile(inputCapture, 'utf8')).length)
            .toBeGreaterThan(0);

        const submitted = await readFile(inputCapture, 'utf8');
        expect(submitted).not.toContain('LONG_PASTE_ORIGINAL_SENTINEL');
        expect(submitted).toContain('[Long paste saved locally]');
        await expect
            .poll(async () =>
                (await readFile(inputCapture, 'utf8')).includes('E2E_SUMMARY_SENTINEL'),
            )
            .toBe(true);

        const summarizedInput = await readFile(inputCapture, 'utf8');
        expect(summarizedInput).toContain('E2E_SUMMARY_SENTINEL');
        const pathMatch = /Original file: ("[^"]+")/u.exec(summarizedInput);
        expect(pathMatch?.[1]).toBeDefined();
        const filePath = JSON.parse(pathMatch![1]) as string;
        const canonicalUserData = await realpath(userData);
        const pasteDirectory = join(canonicalUserData, 'pastes');
        expect(filePath.startsWith(pasteDirectory)).toBe(true);
        expect(await readFile(filePath, 'utf8')).toBe(original);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);

        const summaryCall = JSON.parse(await readFile(summaryCapture, 'utf8')) as {
            inputLength: number;
            model: string;
        };
        expect(summaryCall.model).toBe('gpt-5.6-luna');
        expect(summaryCall.inputLength).toBeGreaterThan(original.length);

        const abandoned = `LONG_PASTE_SWITCH_SENTINEL\n${'y'.repeat(1_100)}`;
        await running.clipboard.writeText(abandoned);
        await input.focus();
        await input.press('Meta+V');
        await expect(status).toBeVisible();
        await secondTab.click();
        await expect(status).toBeHidden();
        await expect(secondTab).toHaveAttribute('aria-selected', 'true');
        await firstTab.click();
        await expect(status).toBeHidden();
        await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
