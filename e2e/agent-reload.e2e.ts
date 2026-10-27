import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { chooseContextMenuItem, contextMenuLabels } from './support/native-context-menu.ts';

const AGENT_SESSION_ID = '5f3c2a1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b';

/**
 * A fake Claude Code that records each launch's arguments and, on its first launch, writes the conversation's
 * transcript and binds the Agent Session through the installed `UserPromptSubmit` hook, so a later resume restart has a
 * conversation to continue.
 */
function reloadableClaude(argumentsCapturePath: string): string {
    return String.raw`#!${process.execPath}
// Deterministic Agent boundary for the Restart Agent workflow; no host provider is discovered.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const home = process.env.CLAUDE_CONFIG_DIR;
const id = ${JSON.stringify(AGENT_SESSION_ID)};
if (process.argv.includes('--version')) { console.log('2.1.263 (Claude Code)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(argumentsCapturePath)}, JSON.stringify(process.argv.slice(2)) + '\n');
if (!process.argv.includes('--resume')) {
  const transcript = path.join(home, 'projects', process.cwd().replaceAll(/[^a-z0-9]/gi, '-'), id + '.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const metadata = path.join(home, 'sessions', 'reload.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ cwd: process.cwd(), sessionId: id, name: 'project', nameSource: 'derived', status: 'idle', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const ready = setInterval(() => { try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    if (!settings.hooks?.UserPromptSubmit?.length) return;
    clearInterval(ready);
    cp.execFileSync('/bin/sh', ['-c', settings.hooks.UserPromptSubmit[0].hooks[0].command], { env: process.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: id }), stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {} }, 50);
}
process.stdout.write('Fake Claude ready\r\n');
process.stdin.resume();
`;
}

test('Restart Agent resumes the same conversation in the approval mode it launched with', async () => {
    // Real path, so the transcript the fake writes under its own cwd sits where Caxri derives it from the Project root.
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-agent-reload-e2e-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const argumentsCapturePath = join(directory, 'claude-arguments.jsonl');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: reloadableClaude(argumentsCapturePath) } },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    const launches = async () =>
        (await readFile(argumentsCapturePath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[]);
    const claudeTerminal = async () =>
        (await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {})).terminals.find(
            ({ provider }) => provider === 'claude',
        );
    /**
     * Waits for launch `index` and checks it continued the bound conversation still in YOLO.
     */
    const expectResumedInYolo = async (index: number) => {
        await expect
            .poll(async () => (await launches()).length, { timeout: 30_000 })
            .toBe(index + 1);
        const launch = (await launches())[index];
        expect(launch).toContain('--dangerously-skip-permissions');
        const resume = launch.indexOf('--resume');
        expect(launch.slice(resume, resume + 2)).toEqual(['--resume', AGENT_SESSION_ID]);
    };
    try {
        const { app, page } = running;
        const sessionId = await createProjectSession(page, 'claude');
        const row = sessionCard(page, sessionId);
        await expect
            .poll(async () => (await claudeTerminal())?.agentSessionId, { timeout: 30_000 })
            .toBe(AGENT_SESSION_ID);
        const { id: terminalId } = (await claudeTerminal())!;
        // The Session launched on the shipped default, which is YOLO.
        expect((await launches())[0]).toContain('--dangerously-skip-permissions');

        // Turning YOLO off in Settings must not silently change the approval mode of the conversation being restarted.
        await pageRequest(page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    claude: {
                        hooks: { enabled: true },
                        launch: { executable: 'claude', args: [] },
                    },
                },
            }),
        });

        await row.click({ button: 'right' });
        // Sits in the Agent group, directly before the Session's other Agent process entry.
        const rowLabels = await contextMenuLabels(app);
        expect(rowLabels.indexOf('Restart Agent')).toBe(rowLabels.indexOf('Detach Agent') - 1);
        await chooseContextMenuItem(app, 'Restart Agent');
        // The fake's turn started (`UserPromptSubmit`) and never stopped, so restarting would end it: the user confirms.
        const confirm = page.getByRole('dialog', { name: 'Stop the running turn?' });
        await expect(confirm).toContainText(
            'Claude is still working. Restarting stops the current turn and resumes the same conversation.',
        );
        await confirm.getByRole('button', { name: 'Stop and Restart' }).click();
        await expectResumedInYolo(1);

        const tab = page.locator(
            `${VISIBLE_SESSION} .work-tab:not([inert])[data-terminal-id="${terminalId}"]`,
        );
        await tab.click({ button: 'right' });
        await chooseContextMenuItem(app, 'Restart Agent');
        await expectResumedInYolo(2);

        // A new conversation follows the current Settings.
        await pageRequest(page, 'terminal.restart', { terminalId, mode: 'fresh' });
        await expect.poll(async () => (await launches()).length, { timeout: 30_000 }).toBe(4);
        expect((await launches())[3]).not.toContain('--dangerously-skip-permissions');
        expect((await launches())[3]).not.toContain('--resume');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
