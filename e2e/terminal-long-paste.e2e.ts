import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';
import { MAX_LONG_PASTE_CHARACTERS } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

/**
 * Compares complete synthetic input without expanding a megabyte-sized payload into failure logs.
 */
function inputFingerprint(value: string) {
    return {
        bytes: Buffer.byteLength(value),
        sha256: createHash('sha256').update(value).digest('hex'),
    };
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Shell-promoted Agent receives a complete native long paste without submitting', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-native-long-paste-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'input.txt');
    await mkdir(root, { recursive: true });
    await writeFile(capture, '');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  console.log('claude-test 2.1.266');
  process.exit(0);
}
process.title = 'claude';
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions', 'current.json'), JSON.stringify({
  cwd: process.cwd(), name: 'Native paste fixture', sessionId: 'native-paste-session',
  startedAt: Date.now(), updatedAt: Date.now(), status: 'idle',
}));
process.stdin.setRawMode(true);
let received = 0;
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(capture)}, chunk);
  received += chunk.length;
  process.stdout.write('\r\nNATIVE_PASTE_RECEIVED=' + received + '\r\n');
});
process.stdin.resume();
process.stdout.write('\u001b[?2004hNATIVE_PASTE_READY\r\n');
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
        await createShellSession(running.page);
        await typeTerminal(running.page, 'claude');
        const pane = running.page.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('NATIVE_PASTE_READY');
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    terminals: Array<{ kind: string; lastAgentProcessState?: string }>;
                }>(running.page, 'app.bootstrap');
                return state.terminals.map(({ kind, lastAgentProcessState }) => ({
                    kind,
                    lastAgentProcessState,
                }));
            })
            .toEqual([{ kind: 'claude', lastAgentProcessState: 'running' }]);
        const original = 'Synthetic handoff line\n'
            .repeat(100)
            .padEnd(MAX_LONG_PASTE_CHARACTERS, 'x');
        await running.clipboard.writeText(original);
        const input = pane.locator('.xterm-helper-textarea');
        await input.focus();
        await input.press('Meta+V');
        const expected = `\u{1B}[200~${original.replaceAll('\n', '\r')}\u{1B}[201~`;
        const capturedInput = async () => inputFingerprint(await readFile(capture, 'utf8'));
        await expect.poll(capturedInput).toEqual(inputFingerprint(expected));
        await expect(
            pane.getByRole('status').filter({ hasText: 'Summarizing pasted text…' }),
        ).toHaveCount(0);
        await input.press('z');
        await expect.poll(capturedInput).toEqual(inputFingerprint(`${expected}z`));
        await expect(pane.locator('.xterm-rows')).toContainText(
            `NATIVE_PASTE_RECEIVED=${Buffer.byteLength(expected) + 1}`,
        );
        expect(await readdir(userData)).not.toContain('pastes');
        await running.page.screenshot({ path: testInfo.outputPath('native-long-paste.png') });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

for (const ancestorProject of [false, true]) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
    test(`long Agent paste preserves the original and sandbox boundary (ancestor Project: ${ancestorProject})`, async ({}) => {
        const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-long-paste-e2e-'));
        const userData = join(testDirectory, 'user-data');
        const root = ancestorProject
            ? join(userData, 'e2e-agents')
            : join(testDirectory, 'project');
        const inputCapture = join(testDirectory, 'agent-input.txt');
        const summaryCapture = join(testDirectory, 'summary-call.json');
        /**
         * Releases the second summary only after the test has switched away from its owning Terminal.
         */
        const summaryRelease = join(testDirectory, 'summary-release');
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
    /** The first call proves the happy path; hold follow-ups so Terminal switching is deterministic. */
    const waitsForRelease = fs.existsSync(${JSON.stringify(summaryCapture)});
    fs.writeFileSync(${JSON.stringify(summaryCapture)}, JSON.stringify({
      inputLength,
      model: process.argv[modelIndex + 1],
      pid: process.pid,
    }));
    const emitSummary = () => {
      process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'E2E_SUMMARY_SENTINEL' },
      }) + '\n');
    };
    if (!waitsForRelease) setTimeout(emitSummary, 1000);
    else {
      const releaseTimer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(summaryRelease)})) return;
        clearInterval(releaseTimer);
        emitSummary();
      }, 25);
    }
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
            const secondTerminal = await pageRequest<{ id: string }>(
                running.page,
                'terminal.create',
                {
                    sessionId,
                    kind: 'codex',
                },
            );
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

            if (ancestorProject) {
                await expect
                    .poll(async () => readFile(inputCapture, 'utf8'))
                    .toContain('Choose a more specific Project folder.');
                const submitted = await readFile(inputCapture, 'utf8');
                expect(submitted).toContain('[Long paste saved locally; summary unavailable]');
                expect(submitted).not.toContain('LONG_PASTE_ORIGINAL_SENTINEL');
                expect(submitted).not.toContain('E2E_SUMMARY_SENTINEL');
                const match = /Original file: ("[^"]+")/u.exec(submitted);
                expect(match).not.toBeNull();
                expect(await readFile(JSON.parse(match![1]) as string, 'utf8')).toBe(original);
                await expect(stat(summaryCapture)).rejects.toMatchObject({ code: 'ENOENT' });
                return;
            }

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
            const normalizedSubmitted = submitted.replaceAll('\r', '\n');
            expect(submitted).not.toContain('LONG_PASTE_ORIGINAL_SENTINEL');
            expect(submitted).toContain('[Long paste saved locally]');
            expect(submitted).toContain(`Original size: 2 lines, ${original.length} characters`);
            expect(normalizedSubmitted).toContain('\n\nSummary:\nE2E_SUMMARY_SENTINEL');
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
                pid: number;
            };
            expect(summaryCall.model).toBe('gpt-5.6-luna');
            expect(summaryCall.inputLength).toBeGreaterThan(original.length);

            const switched = `LONG_PASTE_SWITCH_SENTINEL\n${'y'.repeat(1_100)}`;
            await running.clipboard.writeText(switched);
            await input.focus();
            await input.press('Meta+V');
            await expect(status).toBeVisible();
            await secondTab.click();
            await expect(status).toBeHidden();
            await expect(secondTab).toHaveAttribute('aria-selected', 'true');
            await firstTab.click();
            await expect(firstTab).toHaveAttribute('aria-selected', 'true');
            await expect(status).toBeHidden();
            await expect
                .poll(async () => {
                    const followup = JSON.parse(await readFile(summaryCapture, 'utf8')) as {
                        pid: number;
                    };
                    return followup.pid;
                })
                .not.toBe(summaryCall.pid);
            const followup = JSON.parse(await readFile(summaryCapture, 'utf8')) as { pid: number };
            await writeFile(summaryRelease, 'release');
            /**
             * Wait for the provider process to exit so application cleanup cannot race the abandoned request.
             */
            await expect
                .poll(() => {
                    try {
                        process.kill(followup.pid, 0);
                        return true;
                    } catch {
                        return false;
                    }
                })
                .toBe(false);
            await pageRequest(running.page, 'terminal.runningCount');
            expect(
                (await readFile(inputCapture, 'utf8')).split('E2E_SUMMARY_SENTINEL'),
            ).toHaveLength(2);
            expect(await readFile(inputCapture, 'utf8')).not.toContain(
                'LONG_PASTE_SWITCH_SENTINEL',
            );
        } finally {
            await running.app.close();
            await rm(testDirectory, { recursive: true, force: true });
        }
    });
}
