import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expectComposerValue } from './support/agent-chat-composer.ts';
import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import { setOpenAgentsIn } from './support/open-agents-in.ts';

test('typing after a reload continues the restored Chat draft without opening the Sessions list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-draft-caret-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await page.locator(VISIBLE_SESSION).getByRole('button', { name: 'New Terminal' }).click();
        const terminalMenu = page.getByRole('menu', { name: 'New Terminal' });
        await setOpenAgentsIn(terminalMenu, 'Chat');
        await chooseTerminalFromCreateMenu(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const sessions = chat.getByRole('listbox', { name: 'Sessions' });
        // A draft that ends in `@word`: the restored composer must not open the Sessions list on its own (#1699).
        const draft = 'Please compare with @thr';
        await message.fill(draft);

        await page.reload();
        await expectComposerValue(message, draft);
        await expect(message).toBeFocused();
        await expect(sessions).toHaveCount(0);
        await page.keyboard.type(' Hi');
        await expectComposerValue(message, `${draft} Hi`);
        await expect(sessions).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat recalls sent prompts from a list, stashes a draft with Ctrl+S, and clears it with Ctrl+C', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-history-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const bin = join(directory, 'bin');
    await mkdir(root, { recursive: true });
    await mkdir(bin, { recursive: true });
    // The pull request preview reads a token (`gh auth token`), then its REST read (`gh api repos/<owner>/<repo>/issues/<n>`)
    // answers with a merged pull request.
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
case " $* " in
  *" repos/acme/widgets/issues/7 "*) printf '%s' '{"number":7,"state":"closed","title":"Add widgets","html_url":"https://github.com/acme/widgets/pull/7","pull_request":{"merged_at":"2026-10-01T00:00:00Z"}}' ;;
  " auth token "*) printf '%s\n' 'fake-token' ;;
  *" api graphql -f "*) printf '%s' '{"data":{"rateLimit":{"limit":5000,"remaining":5000,"used":0,"resetAt":"2100-01-01T00:00:00Z"}}}' ;;
  *) exit 1 ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const send = async (prompt: string): Promise<void> => {
            await message.fill(prompt);
            await message.press('Enter');
            await expectComposerValue(message, '');
        };
        await send('first prompt');
        await send('second prompt');
        await send('first prompt');
        await expect(chat.getByText('Hello from fake Codex. You said: first prompt')).toHaveCount(
            2,
        );

        // ArrowUp in the empty input opens the list on the newest prompt; a repeat lists once, at its newest place.
        await message.press('ArrowUp');
        const history = chat.getByRole('listbox', { name: 'Recent prompts' });
        await expect(history.getByRole('option')).toHaveText(['second prompt', 'first prompt']);
        await expect(history.getByRole('option', { name: 'first prompt' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(message).toHaveAttribute('aria-placeholder', 'first prompt');
        await message.press('ArrowUp');
        await expect(message).toHaveAttribute('aria-placeholder', 'second prompt');
        await page.screenshot({ path: testInfo.outputPath('chat-prompt-history.png') });
        // Enter fills the input without sending.
        await message.press('Enter');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, 'second prompt');
        await expect(chat.getByText('Hello from fake Codex. You said: second prompt')).toHaveCount(
            1,
        );

        // Escape closes the list and leaves the input empty; typing closes it and still types.
        await message.fill('');
        await message.press('ArrowUp');
        await expect(history).toBeVisible();
        await message.press('Escape');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, '');
        await message.press('ArrowUp');
        await message.press('x');
        await expect(history).toHaveCount(0);
        await expectComposerValue(message, 'x');

        // Ctrl+S sets a long draft aside so a quick question can go first, then brings it back after the send.
        await message.fill('a long draft to finish later');
        await message.press('Control+s');
        await expectComposerValue(message, '');
        await expect(message).toHaveAttribute(
            'aria-placeholder',
            'Draft stashed · Ctrl+S to restore',
        );
        await page.screenshot({ path: testInfo.outputPath('chat-draft-stashed.png') });
        await message.fill('quick question');
        await message.press('Enter');
        await expectComposerValue(message, 'a long draft to finish later');
        // Ctrl+S in an empty input restores a stash on demand too.
        await message.press('Control+s');
        await expectComposerValue(message, '');
        await message.press('Control+s');
        await expectComposerValue(message, 'a long draft to finish later');
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Codex');

        // A pasted pull request link reads as it will once sent: its state glyph leads it and its text takes that tone.
        const link = 'https://github.com/acme/widgets/pull/7';
        await message.fill(`see ${link}`);
        await expect(chat.locator('.cm-web-link')).toHaveText(link);
        await expect(
            chat.locator('.cm-link-icon [data-pull-request-state="merged"]'),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('chat-composer-link.png') });
        // Ctrl+C over a selection stays Copy and leaves the draft alone.
        await message.press('Meta+a');
        await message.press('Control+c');
        await expectComposerValue(message, `see ${link}`);
        await message.press('End');
        // With nothing selected it empties the input as an ordinary edit, so Cmd+Z brings the text back.
        await message.press('Control+c');
        await expectComposerValue(message, '');
        await message.press('Meta+z');
        await expectComposerValue(message, `see ${link}`);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
