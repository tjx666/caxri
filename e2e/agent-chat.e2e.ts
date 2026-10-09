import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * The deterministic app-server the Server unit tests drive. Reusing it keeps one fake protocol implementation instead
 * of a second, drifting copy for the desktop workflow.
 */
const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '..',
    'apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts',
);

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat streams a reply, answers an approval and a question', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(join(directory, 'codex-threads'))};
import(${JSON.stringify(pathToFileURL(FAKE_APP_SERVER).href)});
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        await chooseTerminalFromCreateMenu(page, 'Codex (Chat)');

        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('hi there');
        // Sent straight away, while the provider may still be starting: the first Enter must not be dropped.
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: hi there')).toBeVisible();
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-reply.png') });

        await message.fill('please approve this');
        await message.press('Enter');
        const approval = chat.getByRole('region', { name: 'Run this command?' });
        await expect(approval).toContainText('echo approved');
        await page.screenshot({ path: testInfo.outputPath('agent-chat-approval.png') });
        await approval.getByRole('button', { name: 'Accept', exact: true }).click();
        await expect(approval).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');

        await message.fill('ask me');
        await message.press('Enter');
        const question = chat.getByRole('region', { name: 'The Agent has a question' });
        await question.getByRole('button', { name: /^Blue/u }).click();
        await question.getByRole('button', { name: 'Submit' }).click();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-question.png') });

        // A crash fails the Chat; Retry restarts the provider on the same conversation and the pane follows it.
        await message.fill('crash now');
        await message.press('Enter');
        const failure = chat.getByRole('alert').filter({ hasText: 'Codex stopped unexpectedly' });
        await expect(failure).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('agent-chat-crashed.png') });
        await failure.getByRole('button', { name: 'Retry' }).click();
        await expect(failure).toHaveCount(0);
        await message.fill('back again');
        await message.press('Enter');
        await expect(chat.getByText('Hello from fake Codex. You said: back again')).toBeVisible();
        await expect(chat.getByText('You chose Blue.')).toBeVisible();

        // The tab strip's `+` clones the live primary Agent on its own surface: a Chat, not a PTY.
        await chat.getByRole('button', { name: 'New Terminal (Codex Chat)' }).click();
        await expect(chat.getByText('You chose Blue.')).toHaveCount(0);
        await expect(message).toHaveAttribute('placeholder', 'Message Codex');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
