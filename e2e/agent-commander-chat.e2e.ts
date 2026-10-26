import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { CommanderSnapshot } from '@caxri/protocol';

import { openBackgroundWork } from './support/agent-chat-background-work.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
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
 * The Commander window mounts no pane layout, so its Chat cannot open a subagent's tab beside itself. The task stays
 * listed (and stoppable) as a plain row instead of a button that would write an invisible tab into the Commander
 * Session's persisted layout (issue caxri#1719).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat Commander lists background work without opening tabs it cannot show', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-commander-chat-e2e-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    /**
     * One fake `codex` for both surfaces: `app-server` runs the deterministic Server-test fixture, and the Commander's
     * own PTY launch is a stand-in TUI that only waits.
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
  process.stdout.write('Fake Codex Commander TUI\r\n');
  process.stdin.resume();
}
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        await expect(commander.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake Codex Commander TUI',
        );

        await commander
            .getByRole('group', { name: 'Open as Terminal or Chat' })
            .getByRole('button', { name: 'Chat' })
            .click();
        const message = commander.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('start a subagent hold');
        await message.press('Enter');

        // The composer strip's Background work section lists the subagent; the window cannot open its tab.
        const chat = commander.locator('body');
        const strip = await openBackgroundWork(chat);
        await expect(strip.getByText('Inspect the fixtures')).toBeVisible();
        await expect(
            strip.getByRole('button', { name: /^Open Inspect the fixtures/u }),
        ).toHaveCount(0);
        // The task is still stoppable from the window.
        await expect(
            strip.getByRole('button', { name: /^Stop Inspect the fixtures/u }),
        ).toBeVisible();
        await commander.screenshot({ path: testInfo.outputPath('commander-chat-task-strip.png') });

        // The parent turn ended and folded at once; its row still names the subagent it started without being
        // expanded, and reveals that subagent's row in place instead of opening a tab (issue caxri#1952).
        const fold = commander.getByRole('button', { name: /^Worked(?: for |$)/u }).first();
        await expect(fold).toHaveAttribute('aria-expanded', 'false');
        const reveal = commander.getByRole('button', {
            name: 'Show subagent Inspect the fixtures in this turn',
        });
        await expect(reveal).toBeVisible();
        await expect(
            commander.getByRole('button', { name: /^Open subagent Inspect the fixtures/u }),
        ).toHaveCount(0);
        await commander.screenshot({
            path: testInfo.outputPath('commander-fold-subagent-running.png'),
        });
        await reveal.click();
        await expect(fold).toHaveAttribute('aria-expanded', 'true');
        const subagentRow = commander.locator('[data-agent-chat-work-item]').filter({
            hasText: 'Inspect the fixtures',
        });
        await expect(subagentRow).toBeInViewport();
        await commander.screenshot({
            path: testInfo.outputPath('commander-fold-subagent-revealed.png'),
        });

        // Clicking the row opens nothing, and the Commander Session's stored layout never gains a task tab.
        await (await openBackgroundWork(chat)).getByText('Inspect the fixtures').click();
        const { identity, workbench } = await pageRequest<CommanderSnapshot>(
            running.page,
            'commander.snapshot',
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
        await commander.screenshot({
            path: testInfo.outputPath('commander-fold-subagent-done.png'),
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
