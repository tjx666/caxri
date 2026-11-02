import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FAKE_CLAUDE_PROMPT_SUGGESTION } from '../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-prompt-suggestions.ts';
import { expectComposerValue } from './support/agent-chat-composer.ts';
import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Claude Chat offers its suggested next message in the empty composer, and Tab takes it', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-prompt-suggestion-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        const offered = `${FAKE_CLAUDE_PROMPT_SUGGESTION} · Tab to use`;

        // Like Claude Code, the first turn ends without a suggestion.
        await message.fill('first note');
        await message.press('Enter');
        await expect(chat.getByText('You said: first note')).toBeVisible();
        await expect(message).toHaveAttribute('aria-placeholder', 'Message Claude');

        await message.fill('second note');
        await message.press('Enter');
        await expect(chat.getByText('You said: second note')).toBeVisible();
        await expect(message).toHaveAttribute('aria-placeholder', offered);
        await page.screenshot({ path: testInfo.outputPath('prompt-suggestion-offered.png') });

        // Tab puts the suggestion in the input without sending it.
        await message.press('Tab');
        await expectComposerValue(message, FAKE_CLAUDE_PROMPT_SUGGESTION);
        await expect(message).toBeFocused();
        await expect(chat.getByText(`You said: ${FAKE_CLAUDE_PROMPT_SUGGESTION}`)).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('prompt-suggestion-accepted.png') });

        // Sending starts a turn, so the suggestion stops describing the conversation until the next one arrives.
        await message.press('Enter');
        await expect(chat.getByText(`You said: ${FAKE_CLAUDE_PROMPT_SUGGESTION}`)).toBeVisible();
        await expectComposerValue(message, '');
        // With text in the input, Tab is left alone.
        await message.fill('x');
        await message.press('Tab');
        await expectComposerValue(message, 'x');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
