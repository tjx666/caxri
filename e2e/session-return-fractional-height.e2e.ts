import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

const PROMPT = 'walk the repository';

/**
 * One Claude turn long enough to scroll its prompt out of view, so returning to it shows the return hint. Its exact
 * shape matters: together with the zoom below it leaves the transcript view's bottom a fraction of a pixel off the hint
 * slot's laid-out bottom.
 */
const SCRIPT = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                { kind: 'text', text: 'Let me look around first.' },
                ...Array.from({ length: 10 }, (_, index) => ({
                    kind: 'tool',
                    name: index % 3 === 0 ? 'Read' : 'Bash',
                    input:
                        index % 3 === 0
                            ? { file_path: `{{cwd}}/file-${index}.ts` }
                            : { command: `echo step ${index}` },
                    output: `out ${index}\nline 2\nline 3`,
                    durationMs: 300,
                })),
                {
                    kind: 'text',
                    text: Array.from(
                        { length: 25 },
                        (_, index) =>
                            `Reply paragraph ${index + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`,
                    ).join('\n\n'),
                    chunkDelayMs: 10,
                },
            ],
        },
    ],
};

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('closing the return hint in a view of fractional height leaves the transcript still', async ({}) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-return-fraction-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const scriptPath = join(directory, 'script.json');
    await writeFile(scriptPath, JSON.stringify(SCRIPT));
    const agentMode = await fakeClaudeChatAgentMode(userData, undefined, scriptPath);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        // A non-integer zoom gives the transcript view a fractional height, as a composer of fractional height does.
        await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.1),
        );
        const chatId = await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const message = page.locator(VISIBLE_SESSION).getByRole('textbox', { name: 'Message' });
        await message.fill(PROMPT);
        await message.press('Enter');
        await expect(
            page.locator(VISIBLE_SESSION).getByRole('button', { name: 'Stop' }),
        ).toBeVisible();
        await createAdditionalShellSession(page);
        const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
        const chatTerminal = state.terminals.find(
            ({ sessionId, provider }) => sessionId === chatId && provider === 'claude',
        );
        if (!chatTerminal) throw new Error('Chat Terminal missing');
        // The turn ends while another Session is selected.
        await expect
            .poll(
                async () => {
                    const snapshot = await pageRequest<{ turns: Array<{ status: string }> }>(
                        page,
                        'agentChat.read',
                        { terminalId: chatTerminal.id },
                    );
                    return snapshot.turns.map(({ status }) => status);
                },
                { timeout: 60_000 },
            )
            .toEqual(['completed']);
        await sessionCard(page, chatId).click();
        const hint = page.getByRole('status').filter({ hasText: 'new repl' });
        await expect(hint).toBeVisible();
        const transcript = page.locator(VISIBLE_SESSION).getByRole('log');
        await hint.getByRole('button', { name: 'Dismiss' }).click();
        await expect(hint).toBeHidden();
        // Each scroll event used to shrink the hint's slot by the fraction the view's bottom read short, and the clamp
        // that followed fired the next one, so the idle view slid one device pixel per frame until the slot was gone.
        const offsets = await transcript.evaluate(async (view) => {
            const seen = new Set<number>();
            for (let frame = 0; frame < 90; frame += 1) {
                // eslint-disable-next-line no-await-in-loop -- one sample per frame
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                seen.add(view.scrollTop);
            }
            return [...seen];
        });
        expect(offsets).toHaveLength(1);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
