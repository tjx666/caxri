import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

async function hasPath(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a finished Codex turn shows its edited files with Undo and the pull request, issue, and acceptance report it filed', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-artifacts-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        await app.evaluate(({ dialog, shell }) => {
            const { rename } = process.getBuiltinModule('node:fs').promises;
            const target = globalThis as typeof globalThis & { caxriOpenedLinks?: string[] };
            target.caxriOpenedLinks = [];
            // Answers both the Trash confirmation and the untrusted-domain prompt with their first button.
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.trashItem = (path) => rename(path, `${path}.trashed`);
            shell.openExternal = (url) => {
                target.caxriOpenedLinks!.push(url);
                return Promise.resolve();
            };
        });
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('artifacts please');
        await message.press('Enter');

        const changes = chat.locator('[data-agent-chat-turn-changes]');
        await expect(changes.getByText('Edited 2 files')).toBeVisible();
        await expect(
            changes.getByRole('button', { name: 'View changes, 5 lines added, 1 removed' }),
        ).toBeVisible();
        await expect(changes.getByRole('listitem')).toHaveText([
            /src\/greeting\.ts\s*\+2\s*-1/,
            /docs\/greeting\.md\s*\+3/,
        ]);
        const pull = chat.getByRole('button', {
            name: 'Created pull request: Greet with punctuation, acme/widgets#42. Open in browser',
        });
        const issue = chat.getByRole('button', {
            name: 'Created issue: Document the greeting, ENG-12. Open in browser',
        });
        await expect(pull).toBeVisible();
        // A body rewritten through `gh api -X PATCH` names its pull request in the endpoint alone.
        await expect(
            chat.getByRole('button', {
                name: 'Updated pull request: acme/widgets#40, acme/widgets#40. Open in browser',
            }),
        ).toBeVisible();
        await expect(issue).toContainText('Explain how greet formats a name.');
        const acceptance = chat.getByRole('button', {
            name: 'Created acceptance report: Greeting ends with punctuation, Round 1. Open in browser',
        });
        await expect(acceptance).toContainText('3 checks');
        await chat
            .locator('[data-agent-chat-turn-changes]')
            .locator('..')
            .screenshot({
                path: testInfo.outputPath('turn-artifacts.png'),
            });

        // Hovering the counts swaps them for View changes and previews every diff.
        await changes.getByRole('button', { name: /^View changes, / }).hover();
        await expect(page.getByText('const greeting = `Hello, ${name}!`;').first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('turn-artifacts-hover.png') });
        await page.mouse.move(0, 0);

        // The counts are the card's one inline toggle: clicking them discloses every diff in place.
        await changes.getByRole('button', { name: /^View changes, / }).click();
        await expect(changes.getByRole('button', { name: /^Hide changes, / })).toBeVisible();
        await expect(changes.getByText('Call `greet(name)`.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('turn-artifacts-expanded.png') });
        await changes.getByRole('button', { name: /^Hide changes, / }).click();

        await pull.click();
        await expect
            .poll(() =>
                app.evaluate(
                    () =>
                        (globalThis as typeof globalThis & { caxriOpenedLinks?: string[] })
                            .caxriOpenedLinks ?? [],
                ),
            )
            .toContain('https://github.com/acme/widgets/pull/42');
        await acceptance.click();
        await expect
            .poll(() =>
                app.evaluate(
                    () =>
                        (globalThis as typeof globalThis & { caxriOpenedLinks?: string[] })
                            .caxriOpenedLinks ?? [],
                ),
            )
            .toContain('https://app.lobehub.com/acceptance/00000000-0000-4000-8000-000000000042');

        await changes.getByRole('button', { name: 'Undo' }).click();
        await expect(changes.getByText('Undone')).toBeVisible();
        await expect
            .poll(() => readFile(join(root, 'src', 'greeting.ts'), 'utf8'))
            .toBe("export function greet(name: string) {\n    return 'Hello ' + name;\n}\n");
        expect(await hasPath(join(root, 'docs', 'greeting.md'))).toBe(false);
        expect(await hasPath(join(root, 'docs', 'greeting.md.trashed'))).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('turn-artifacts-undone.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a turn card lists its first three files and folds the rest behind a Show more row', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-many-files-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('manyfiles please');
        await message.press('Enter');

        const changes = chat.locator('[data-agent-chat-turn-changes]');
        await expect(changes.getByText('Edited 5 files')).toBeVisible();
        await expect(changes.getByRole('listitem')).toHaveText([
            /notes\/note-1\.md/,
            /notes\/note-2\.md/,
            /notes\/note-3\.md/,
        ]);
        const toggle = changes.getByRole('button', { name: 'Show 2 more files' });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await page.screenshot({ path: testInfo.outputPath('turn-files-folded.png') });

        await toggle.click();
        await expect(changes.getByRole('listitem')).toHaveCount(5);
        await expect(changes.getByRole('button', { name: 'Show fewer files' })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await changes.getByRole('button', { name: 'Show fewer files' }).click();
        await expect(changes.getByRole('listitem')).toHaveCount(3);

        // Disclosing every diff lists every file, so no diff opens behind the folded rows.
        await changes.getByRole('button', { name: /^View changes, / }).click();
        await expect(changes.getByRole('listitem')).toHaveCount(5);

        // Folding closes the hidden rows' diffs, so the header no longer reads as every diff being open.
        await changes.getByRole('button', { name: 'Show fewer files' }).click();
        await expect(changes.getByRole('button', { name: /^View changes, / })).toBeVisible();
        await changes.getByRole('button', { name: 'Show 2 more files' }).click();
        await expect(
            changes.getByRole('button', { name: /^Show changes: notes\/note-5\.md/ }),
        ).toHaveAttribute('aria-expanded', 'false');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
