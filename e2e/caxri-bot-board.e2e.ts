import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * A synthetic Caxri Bot that creates one Session and delegates a task into it through the real CLI and its own Agent
 * Endpoint, recording only IDs and exit codes. The CLI path is passed in because the Caxri Bot workspace is outside the
 * checkout.
 */
function delegatingBotSource(cliPath: string, resultPath: string, taskPath: string): string {
    return `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(0);
process.stdin.setRawMode?.(true);
process.stdin.resume();
const cli = args => spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...args, '--json'], { encoding: 'utf8', env: process.env, timeout: 45000 });
const record = value => fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value));
const board = cli(['bot', 'board']);
if (board.status !== 0) { record({ step: 'board', code: board.status }); return; }
const projectId = JSON.parse(board.stdout).rows[0]?.projectId;
const created = cli(['bot', 'session', 'create', '--project', projectId]);
if (created.status !== 0) { record({ step: 'session', code: created.status }); return; }
const { sessionId } = JSON.parse(created.stdout);
fs.writeFileSync(${JSON.stringify(taskPath)}, 'Synthetic task');
const delegated = cli(['agent', 'delegate', 'create', '--project', projectId, '--session', sessionId, '--prompt-file', ${JSON.stringify(taskPath)}, '--provider', 'grok']);
if (delegated.status !== 0) { record({ step: 'delegate', code: delegated.status }); return; }
record({ step: 'done', sessionId, delegationId: JSON.parse(delegated.stdout).delegationId });
`;
}

/**
 * A delegated Agent that starts and then sits silent, as a real one does at a folder-trust or sign-in prompt: its
 * process lives, but no lifecycle hook ever reports a session.
 */
const WAITING_AGENT_SOURCE = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('grok 1.0.24'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
`;

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot board moves a task stuck at Agent startup to Needs attention', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-board-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const resultPath = join(directory, 'result.json');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: delegatingBotSource(
                    join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs'),
                    resultPath,
                    join(directory, 'task.md'),
                ),
            },
            grok: { executableSource: WAITING_AGENT_SOURCE },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        /**
         * A visible delegation launches only a provider whose lifecycle hooks are installed and enabled.
         */
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['agents.providers'].grok.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
        await createShellSession(running.page);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;

        const readResult = async () => {
            try {
                return JSON.parse(await readFile(resultPath, 'utf8')) as {
                    step: string;
                    sessionId?: string;
                };
            } catch {
                return;
            }
        };
        await expect.poll(readResult).toMatchObject({ step: 'done' });
        const { sessionId } = (await readResult())!;
        /**
         * The startup deadline (15 seconds) moves the task to `blocked`/`startup_waiting`. The board's 10-second poll
         * also picks that up, so this proves the attention path end to end, not the latency of the receipt event; the
         * event itself is covered by the delegation service tests.
         */
        const task = bot.locator(
            `li[data-session-id="${sessionId}"][data-bot-group="attention"] .bot-board-task`,
        );
        await expect(task).toHaveAttribute('data-task-label', 'Waiting at startup', {
            timeout: 45_000,
        });
        await testInfo.attach('bot-board-needs-you', {
            body: await bot.locator('.bot-board').screenshot(),
            contentType: 'image/png',
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
