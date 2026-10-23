import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectComposerValue } from './support/agent-chat-composer.ts';
import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * Code selected in an editor offers Add to Chat over the selection (`EditorSelectionToolbar`), which appends the
 * selection's `@path#L<start>-L<end>` reference to the Session's Agent Chat draft and brings that Chat forward.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('an editor selection adds its line reference to the Agent Chat draft', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-editor-selection-toolbar-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
        join(root, 'src', 'notes.ts'),
        'const first = 1;\nconst second = 2;\nconst third = 3;\n',
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();

        const tree = page.getByRole('tree', { name: 'Files' });
        await tree.getByRole('treeitem', { name: /^src/ }).click();
        await tree.getByRole('treeitem', { name: /^notes\.ts/ }).dblclick();
        const editor = page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('const second');
        await editor.locator('.view-line').first().click();
        await page.keyboard.press('Meta+ArrowUp');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+End');

        const toolbar = page.getByRole('toolbar', { name: 'Selection actions' });
        const addToChat = toolbar.getByRole('button', { name: /^Add to Chat/u });
        await expect(addToChat).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('editor-selection-toolbar.png') });
        await addToChat.click();

        await expect(toolbar).toHaveCount(0);
        await expectComposerValue(message, '@src/notes.ts#L1-L2 ');
        await expect(message).toBeFocused();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
