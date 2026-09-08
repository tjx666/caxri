import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

const RESUMED_THREAD = '019a0000-0000-7000-8000-000000000042';

for (const entry of ['shell', 'codex', 'exited-codex'] as const) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
    test(`manual Codex resume from ${entry} tracks the resumed turn in the sidebar`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-manual-resume-'));
        const userData = join(directory, 'user-data');
        const root = join(directory, 'project');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                codex: {
                    executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.153.4\n');
  process.exit(0);
}
let thread = process.argv.includes('resume') ? '${RESUMED_THREAD}' : '019a0000-0000-7000-8000-000000000001';
function hook(event) {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  for (const group of config.hooks[event] ?? []) {
    for (const definition of group.hooks) {
      cp.execFileSync('/bin/sh', ['-c', definition.command], {
        input: JSON.stringify({ session_id: thread, turn_id: 'fixture-turn', cwd: process.cwd() }),
        stdio: ['pipe', 'ignore', 'inherit'],
      });
    }
  }
}
hook('SessionStart');
let input = '';
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const character of chunk.toString()) {
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    const command = input; input = '';
    if (command === 'exit') process.exit(0);
    else if (command.startsWith('/resume')) { thread = '${RESUMED_THREAD}'; hook('SessionStart'); }
    else if (command === 'work') hook('UserPromptSubmit');
    else if (command === 'finish') hook('Stop');
    process.stdout.write('Fixture input handled\r\n');
  }
});
process.stdout.write('Fake Codex ready\r\n');
`,
                },
            },
        });
        const running = await launchCaxri({
            agentMode,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
            testRootPath: root,
            userDataDir: userData,
        });
        try {
            const current = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
            const settings = structuredClone(current.value);
            settings['agents.providers'].codex.hooks.enabled = true;
            settings['agents.providers'].codex.naming.enabled = false;
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify(settings),
            });
            await expect
                .poll(async () => {
                    try {
                        return await readFile(
                            join(userData, 'e2e-agents/codex/hooks.json'),
                            'utf8',
                        );
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                        throw error;
                    }
                })
                .toContain('UserPromptSubmit');
            if (entry === 'shell') {
                await createShellSession(running.page);
                await typeTerminal(running.page, `codex resume ${RESUMED_THREAD}`);
            } else {
                await createProjectSession(running.page, 'codex');
            }
            await expect(running.page.locator('.xterm-rows')).toContainText('Fake Codex ready');
            if (entry === 'codex') await typeTerminal(running.page, `/resume ${RESUMED_THREAD}`);
            else if (entry === 'exited-codex') {
                await typeTerminal(running.page, 'exit');
                await expect
                    .poll(async () => {
                        const state = await pageRequest<BootstrapState>(
                            running.page,
                            'app.bootstrap',
                        );
                        return state.terminals[0]?.lastAgentProcessState;
                    })
                    .toBe('stopped');
                await typeTerminal(running.page, `codex resume ${RESUMED_THREAD}`);
                await expect
                    .poll(async () => {
                        const state = await pageRequest<BootstrapState>(
                            running.page,
                            'app.bootstrap',
                        );
                        return state.terminals[0]?.lastAgentProcessState;
                    })
                    .toBe('running');
            }
            await typeTerminal(running.page, 'work');
            await expect
                .poll(async () => {
                    const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                    return state.terminals[0]?.agentSessionId;
                })
                .toBe(RESUMED_THREAD);
            const status = running.page.locator('[data-session-status="running"]');
            await expect(status).toBeVisible();
            await running.page.screenshot({ path: testInfo.outputPath('resumed-running.png') });
            await typeTerminal(running.page, 'finish');
            await expect(status).toHaveCount(0);
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
