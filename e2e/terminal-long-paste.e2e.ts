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
            pane.getByRole('status').filter({ hasText: 'Saving pasted text…' }),
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('long Agent paste reaches the Agent as a reference to the locally saved original', async ({}) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-long-paste-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const inputCapture = join(testDirectory, 'agent-input.txt');
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
/** Bounded single-turn calls belong to Session naming, never to a paste; drain and exit so none can hang. */
if (process.argv.includes('--ephemeral')) {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
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
        expect(currentSettings.value['terminal.longPasteThreshold']).toBe(2_048);

        await createProjectSession(running.page, 'codex');
        const rows = running.page.locator('.xterm-rows');
        const input = running.page.locator('.xterm-helper-textarea');
        await expect(rows).toContainText('LONG_PASTE_AGENT_READY');
        const original = `LONG_PASTE_ORIGINAL_SENTINEL\n${'x'.repeat(2_100)}`;
        await running.clipboard.writeText(original);
        await input.focus();
        await input.press('Meta+V');

        await expect.poll(async () => (await stat(inputCapture)).size).toBeGreaterThan(0);
        await expect
            .poll(async () => (await readFile(inputCapture, 'utf8')).includes('Original file:'))
            .toBe(true);

        const submitted = await readFile(inputCapture, 'utf8');
        expect(submitted).not.toContain('LONG_PASTE_ORIGINAL_SENTINEL');
        expect(submitted).toContain('[Long paste saved locally]');
        expect(submitted).toContain(`Original size: 2 lines, ${original.length} characters`);
        expect(submitted).toContain('delegate it to a subagent');

        const pathMatch = /Original file: ("[^"]+")/u.exec(submitted);
        expect(pathMatch?.[1]).toBeDefined();
        const filePath = JSON.parse(pathMatch![1]) as string;
        const canonicalUserData = await realpath(userData);
        expect(filePath.startsWith(join(canonicalUserData, 'pastes'))).toBe(true);
        expect(await readFile(filePath, 'utf8')).toBe(original);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
