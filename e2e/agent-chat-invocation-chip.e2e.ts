import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
test('a recognized leading /command shows as a chip in the Chat composer, while unknown text stays plain', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-invocation-chip-'));
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
        const chip = chat.getByRole('img', { name: 'command: compact' });

        // A token still being typed stays editable text; a space completes it into the chip.
        await message.fill('/compact');
        await expect(chat.getByRole('listbox', { name: 'Commands and skills' })).toBeVisible();
        await expect(chip).toHaveCount(0);
        await message.pressSequentially(' now');
        await expect(chip).toBeVisible();
        await expectComposerValue(message, '/compact now');
        await page.screenshot({ path: testInfo.outputPath('composer-command-chip.png') });

        // Delete from the start removes the whole chip at once.
        await message.press('Home');
        await message.press('Delete');
        await expect(chip).toHaveCount(0);
        await expectComposerValue(message, ' now');

        // A command the menu does not offer stays plain text.
        await message.fill('/nope later');
        await expect(chat.locator('.cm-invocation-chip')).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
