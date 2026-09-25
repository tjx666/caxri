import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

for (const ancestorProject of [false, true]) {
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
    test(`a completed turn names safely and preserves manual ownership (ancestor Project: ${ancestorProject})`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-title-sync-e2e-'));
        const userData = join(directory, 'user-data');
        const root = ancestorProject ? join(userData, 'e2e-agents') : join(directory, 'project');
        await mkdir(root, { recursive: true });
        const mode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                claude: {
                    executableSource: String.raw`#!${process.execPath}
// Deterministic Agent boundary for this Session naming workflow; no host provider is discovered.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const home = process.env.CLAUDE_CONFIG_DIR;
const receipt = path.join(home, 'naming-receipt.json');
const metadata = path.join(home, 'sessions', 'naming.json');
if (process.argv.includes('--version')) { console.log('2.1.263 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--resume')) {
  const name = process.argv.at(-1).slice('/rename '.length);
  const state = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  const transcript = path.join(home, 'projects', state.cwd.replaceAll(/[^a-z0-9]/gi, '-'), state.sessionId + '.jsonl');
  fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: name }) + '\n');
  const counts = JSON.parse(fs.readFileSync(receipt, 'utf8')); counts.renames += 1; fs.writeFileSync(receipt, JSON.stringify(counts));
  console.log(JSON.stringify({ is_error: false, result: 'Session renamed to: ' + name, session_id: state.sessionId, subtype: 'success', type: 'result' })); process.exit(0);
}
if (process.argv.includes('--print')) {
  process.stdin.resume(); process.stdin.on('end', () => {
    const counts = JSON.parse(fs.readFileSync(receipt, 'utf8')); counts.generations += 1; fs.writeFileSync(receipt, JSON.stringify(counts));
    console.log('会话标题同步');
  });
} else {
  const id = 'naming-fixture-session';
  const folder = path.join(home, 'projects', process.cwd().replaceAll(/[^a-z0-9]/gi, '-'));
  fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ generations: 0, renames: 0, turns: 0 }));
  const state = { cwd: process.cwd(), sessionId: id, name: 'project-xx', nameSource: 'derived', status: 'busy', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(metadata, JSON.stringify(state));
  const transcript = path.join(folder, id + '.jsonl');
  fs.writeFileSync(transcript, [ { type: 'user', message: { content: 'TASK-1234' } }, { type: 'assistant', message: { content: '需要修复会话标题同步。' } }, { type: 'ai-title', aiTitle: 'Analyze image' } ].map(JSON.stringify).join('\n') + '\n');
  function hook(event) { const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); cp.execFileSync('/bin/sh', ['-c', settings.hooks[event][0].hooks[0].command], { env: process.env, input: JSON.stringify({ hook_event_name: event, session_id: id }), stdio: ['pipe', 'ignore', 'ignore'] }); }
  const ready = setInterval(() => { try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    if (!settings.hooks?.Stop?.length) return;
    clearInterval(ready); hook('UserPromptSubmit');
    state.status = 'idle'; state.updatedAt = new Date().toISOString(); fs.writeFileSync(metadata, JSON.stringify(state)); hook('Stop');
    setInterval(() => { hook('UserPromptSubmit'); fs.appendFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Analyze image again' }) + '\n'); hook('Stop'); const counts = JSON.parse(fs.readFileSync(receipt, 'utf8')); counts.turns += 1; fs.writeFileSync(receipt, JSON.stringify(counts)); }, 2000);
  } catch {} }, 50);
  process.stdin.resume();
}
`,
                },
            },
        });
        const running = await launchCaxri({
            userDataDir: userData,
            testRootPath: root,
            agentMode: mode,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        });
        try {
            await createProjectSession(running.page, 'claude');
            if (ancestorProject) {
                await expect(
                    running.page.getByText(
                        'Automatic naming is blocked by the Project sandbox boundary. Choose a more specific Project folder and restart the Agent.',
                        { exact: false },
                    ),
                ).toBeVisible();
                await running.app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]?.showInactive(),
                );
                try {
                    await running.page.screenshot({
                        path: testInfo.outputPath('sandbox-naming-notice.png'),
                    });
                } finally {
                    await running.app.evaluate(({ BrowserWindow }) =>
                        BrowserWindow.getAllWindows()[0]?.hide(),
                    );
                }
                const receiptPath = join(userData, 'e2e-agents', 'claude', 'naming-receipt.json');
                await expect
                    .poll(
                        async () =>
                            (JSON.parse(await readFile(receiptPath, 'utf8')) as { turns: number })
                                .turns,
                    )
                    .toBeGreaterThanOrEqual(2);
                expect(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown).toMatchObject({
                    generations: 0,
                    renames: 0,
                });
                return;
            }
            await expect
                .poll(
                    async () =>
                        (await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {}))
                            .sessions[0]?.displayTitle,
                    { timeout: 30_000 },
                )
                .toBe('会话标题同步');
            const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {});
            const session = state.sessions[0];
            const receiptPath = join(userData, 'e2e-agents', 'claude', 'naming-receipt.json');
            await expect
                .poll(
                    async () =>
                        (JSON.parse(await readFile(receiptPath, 'utf8')) as { turns: number })
                            .turns,
                )
                .toBeGreaterThanOrEqual(2);
            await expect(
                running.page.getByText('会话标题同步', { exact: true }).first(),
            ).toBeVisible();
            /**
             * Hidden Electron windows can return an unpainted capture; show without taking the developer's focus.
             */
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.showInactive(),
            );
            try {
                await running.page.screenshot({
                    path: testInfo.outputPath('automatic-title.png'),
                    clip: { x: 0, y: 0, width: 236, height: 500 },
                });
            } finally {
                await running.app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]?.hide(),
                );
            }
            await pageRequest(running.page, 'session.rename', {
                sessionId: session.id,
                displayTitle: 'Manual task title',
            });
            await expect
                .poll(
                    async () =>
                        (await pageRequest<BootstrapState>(running.page, 'app.bootstrap', {}))
                            .sessions[0]?.displayTitle,
                )
                .toBe('Manual task title');
            const receipt: unknown = JSON.parse(
                await readFile(
                    join(userData, 'e2e-agents', 'claude', 'naming-receipt.json'),
                    'utf8',
                ),
            );
            expect(receipt).toMatchObject({ generations: 1, renames: 2 });
            await expect(
                running.page.getByText('Manual task title', { exact: true }).first(),
            ).toBeVisible();
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
