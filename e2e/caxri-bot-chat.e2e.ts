import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { BotSnapshot } from '@caxri/protocol';

import { openBackgroundWork } from './support/agent-chat-background-work.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { openCaxriBot } from './support/caxri-bot.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts',
);

/**
 * The Caxri Bot window mounts no pane layout, so its Chat cannot open a subagent's tab beside itself. The task stays
 * listed (and stoppable) as a plain row instead of a button that would write an invisible tab into Caxri Bot Session's
 * persisted layout (issue caxri#1719).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat Caxri Bot lists background work without opening tabs it cannot show', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-bot-chat-e2e-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    /**
     * One fake `codex` for both surfaces: `app-server` runs the deterministic Server-test fixture, and Caxri Bot's own
     * PTY launch is a stand-in TUI that only waits.
     */
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) {
  process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(join(directory, 'codex-threads'))};
  import(${JSON.stringify(pathToFileURL(FAKE_APP_SERVER).href)});
} else {
  process.stdout.write('Fake Codex Caxri Bot TUI\r\n');
  process.stdin.resume();
}
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        await expect(bot.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake Codex Caxri Bot TUI',
        );

        await bot
            .getByRole('group', { name: 'Open as Terminal or Chat' })
            .getByRole('button', { name: 'Chat' })
            .click();
        const message = bot.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('start a subagent hold');
        await message.press('Enter');

        // The composer strip's Background work section lists the subagent; the window cannot open its tab.
        const chat = bot.locator('body');
        const strip = await openBackgroundWork(chat);
        await expect(strip.getByText('Inspect the fixtures')).toBeVisible();
        await expect(
            strip.getByRole('button', { name: /^Open Inspect the fixtures/u }),
        ).toHaveCount(0);
        // The task is still stoppable from the window.
        await expect(
            strip.getByRole('button', { name: /^Stop Inspect the fixtures/u }),
        ).toBeVisible();
        await bot.screenshot({ path: testInfo.outputPath('bot-chat-task-strip.png') });

        // The parent turn ended and folded at once; its row still names the subagent it started without being
        // expanded, and reveals that subagent's row in place instead of opening a tab (issue caxri#1952).
        const fold = bot.getByRole('button', { name: /^Worked(?: for |$)/u }).first();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        const reveal = bot.getByRole('button', {
            name: 'Show subagent Inspect the fixtures in this turn',
        });
        await expect(reveal).toBeVisible();
        await expect(
            bot.getByRole('button', { name: /^Open subagent Inspect the fixtures/u }),
        ).toHaveCount(0);
        await bot.screenshot({
            path: testInfo.outputPath('bot-fold-subagent-running.png'),
        });
        await reveal.click();
        await expect(fold).toHaveAttribute('aria-expanded', 'true');
        const subagentRow = bot.locator('[data-agent-chat-work-item]').filter({
            hasText: 'Inspect the fixtures',
        });
        await expect(subagentRow).toBeInViewport();
        await bot.screenshot({
            path: testInfo.outputPath('bot-fold-subagent-revealed.png'),
        });

        // Clicking the row opens nothing, and the Caxri Bot Session's stored layout never gains a task tab.
        await (await openBackgroundWork(chat)).getByText('Inspect the fixtures').click();
        const { identity, workbench } = await pageRequest<BotSnapshot>(
            running.page,
            'bot.snapshot',
        );
        const state = workbench.sessionStates.find(
            ({ sessionId }) => sessionId === identity.sessionId,
        );
        expect(JSON.stringify(state ?? {})).not.toContain('caxri-agent-task://');

        // Once the subagent ends and the Background work section leaves, the folded row still names it.
        await (
            await openBackgroundWork(chat)
        )
            .getByRole('button', { name: /^Stop Inspect the fixtures/u })
            .click();
        await fold.click();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        await expect(reveal).toBeVisible();
        await bot.screenshot({
            path: testInfo.outputPath('bot-fold-subagent-done.png'),
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
