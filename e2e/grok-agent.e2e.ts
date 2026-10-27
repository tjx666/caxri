import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture';
import { expect, test } from './support/fixtures';
import { createProjectSession, launchCaxri, pageRequest, typeTerminal } from './support/helpers';

const switchedSessionId = '49cc1001-2b93-4bb3-9ee8-104e8dcdd699';
const initialTitle = 'Fixture Grok conversation';
const refreshedTitle = 'Fixture Grok conversation refreshed';

for (const entry of ['managed', 'shell'] as const) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring
    test(`Grok Build from ${entry} identifies switched sessions, reports failures and restores the exact conversation`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-grok-e2e-'));
        const root = join(directory, 'project');
        const userDataDirectory = join(directory, 'profile');
        const receipts = join(directory, 'launches.jsonl');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userDataDirectory,
            providers: {
                grok: {
                    executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { process.stdout.write('grok 1.0.24\n'); process.exit(0); }
const resume = process.argv.indexOf('--resume');
let sessionId = process.argv[(resume >= 0 ? resume : process.argv.indexOf('--session-id')) + 1];
const initialId = sessionId;
let promptId = 'fixture-turn';
fs.appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ sessionId, resumed: resume >= 0 }) + '\n');
function hook(event, extra = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.GROK_HOME, 'hooks', 'caxri.json'), 'utf8'));
  for (const group of config.hooks[event] ?? []) for (const entry of group.hooks)
    cp.execFileSync('/bin/sh', ['-c', entry.command], { input: JSON.stringify({ sessionId, promptId, cwd: process.cwd(), ...extra }),
      env: { ...process.env, GROK_SESSION_ID: sessionId }, stdio: ['pipe', 'ignore', 'inherit'] });
}
let title = ${JSON.stringify(initialTitle)};
function summarize() {
  const folder = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(fs.realpathSync(process.cwd())), sessionId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ generated_title: title, session_summary: title }));
}
function identify(source) {
  summarize();
  hook('SessionStart', { source });
}
identify(resume >= 0 ? 'load' : 'new');
let input = '';
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', chunk => {
  for (const character of chunk.toString()) {
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    const command = input; input = '';
    if (command === '/new') { sessionId = '${switchedSessionId}'; identify('new'); }
    if (command === 'work') hook('UserPromptSubmit');
    if (command === 'finish') hook('Stop', { reason: 'end_turn' });
    if (command === 'fail') hook('StopFailure', { reason: 'api_error' });
    if (command === 'retitle') { title = ${JSON.stringify(refreshedTitle)}; summarize(); }
    if (command === 'old') hook('Stop', { sessionId: initialId, reason: 'end_turn' });
    if (command === 'shutdown') hook('Stop', { reason: 'shutdown', promptId: undefined });
    process.stdout.write('Fixture input handled\r\n');
  }
});
process.stdout.write('Fake Grok ready\r\n');
`,
                },
            },
        });
        const launch = {
            agentMode,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
            testRootPath: root,
            userDataDir: userDataDirectory,
            quitDecisionOnClose: 'keep-running' as const,
        };
        let running = await launchCaxri(launch);
        try {
            await expect
                .poll(async () => {
                    try {
                        return await readFile(
                            join(userDataDirectory, 'e2e-agents/grok/hooks/caxri.json'),
                            'utf8',
                        );
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                        throw error;
                    }
                })
                .toContain('SessionStart');
            await createProjectSession(running.page, entry === 'managed' ? 'grok' : 'shell');
            if (entry === 'shell')
                await typeTerminal(
                    running.page,
                    'grok --session-id 49cc1001-2b93-4bb3-9ee8-104e8dcdd698 --sandbox workspace',
                );
            await expect(running.page.locator('.xterm-rows')).toContainText('Fake Grok ready');
            await typeTerminal(running.page, '/new');
            const state = () => pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            await expect
                .poll(async () => (await state()).terminals[0]?.agentSessionId)
                .toBe(switchedSessionId);
            await expect.poll(async () => (await state()).sessions[0]?.title).toBe(initialTitle);
            await expect(running.page.getByText(initialTitle).first()).toBeVisible();
            await typeTerminal(running.page, 'retitle');
            await expect.poll(async () => (await state()).sessions[0]?.title).toBe(refreshedTitle);
            await running.page.screenshot({ path: testInfo.outputPath('grok-title.png') });
            await typeTerminal(running.page, 'work');
            await expect
                .poll(async () => (await state()).sessions[0]?.agentActivityState)
                .toBe('running');
            await typeTerminal(running.page, 'old');
            await typeTerminal(running.page, 'shutdown');
            expect((await state()).sessions[0]?.agentActivityState).toBe('running');
            await typeTerminal(running.page, 'fail');
            await expect
                .poll(async () => (await state()).sessions[0]?.agentActivityState)
                .toBe('failed');
            await running.page.screenshot({ path: testInfo.outputPath('grok-failed.png') });
            await typeTerminal(running.page, 'work');
            await typeTerminal(running.page, 'finish');
            await expect
                .poll(async () => (await state()).sessions[0]?.agentActivityState)
                .toBe('completed');
            await running.app.close();
            running = await launchCaxri(launch);
            await expect(running.page.locator('.xterm-rows')).toContainText('Fake Grok ready');
            await expect
                .poll(async () => {
                    const lines = (await readFile(receipts, 'utf8')).trim().split('\n');
                    return JSON.parse(lines.at(-1)!) as { sessionId: string; resumed: boolean };
                })
                .toEqual({ sessionId: switchedSessionId, resumed: true });
            await running.page.screenshot({ path: testInfo.outputPath('grok-restored.png') });
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
