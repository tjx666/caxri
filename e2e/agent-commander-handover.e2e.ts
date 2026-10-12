import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

const CONVERSATION_ID = 'outside-conversation-1';
const CONVERSATION_TITLE = 'Investigate the flaky upload test';

/**
 * A Claude Code conversation the user started in another terminal app, in Claude's own history layout
 * (`projects/<encoded cwd>/<session id>.jsonl`). Written an hour ago so it does not read as still open.
 */
async function seedOutsideConversation(configDirectory: string, cwd: string): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/gi, '-'),
        `${CONVERSATION_ID}.jsonl`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        `${JSON.stringify({
            type: 'user',
            cwd,
            entrypoint: 'cli',
            isSidechain: false,
            sessionId: CONVERSATION_ID,
            uuid: `${CONVERSATION_ID}-u`,
            message: { role: 'user', content: CONVERSATION_TITLE },
        })}\n`,
    );
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(path, anHourAgo, anHourAgo);
}

/**
 * From the Commander window, the user picks every Session of a Project with the group checkbox and one Claude
 * conversation started outside Caxri, then hands them over in one batch. The Commander then manages all three, and the
 * outside conversation became a Workbench Session titled after it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander hand-over picker hands Sessions and an outside conversation over in one batch', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-handover-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    await seedOutsideConversation(agentMode.environment.CLAUDE_CONFIG_DIR!, await realpath(root));
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await createAdditionalShellSession(running.page);
        const before = await pageRequest<{ sessions: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const ownSessionIds = before.sessions.map(({ id }) => id);
        expect(ownSessionIds).toHaveLength(2);

        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        await expect(commander.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake codex ready',
        );

        await commander.locator('.agent-commander-handover').click();
        const dialog = commander.getByRole('dialog', { name: 'Hand Over to Agent Commander' });
        await expect(dialog).toBeVisible();
        // The Commander's own Session is never offered.
        await expect(dialog.locator('.commander-handover-row')).toHaveCount(2);
        await dialog.getByRole('checkbox', { name: 'Select all in project' }).click();
        await expect(dialog.getByText('2 selected')).toBeVisible();

        await dialog.locator('.commander-handover-tab-conversations').click();
        const conversationRow = dialog.locator(
            `.commander-handover-row[data-handover-key="claude:${CONVERSATION_ID}"]`,
        );
        await expect(conversationRow).toContainText(CONVERSATION_TITLE);
        await dialog.locator('.commander-handover-search').fill('flaky upload');
        await expect(dialog.locator('.commander-handover-row')).toHaveCount(1);
        await conversationRow.getByRole('checkbox').click();
        // The search hides nothing that stays selected: the two Sessions still count.
        await expect(dialog.getByText('3 selected')).toBeVisible();
        await testInfo.attach('commander-handover-picker', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });

        await dialog.locator('.commander-handover-submit').click();
        await expect(dialog).toBeHidden();
        await expect(commander.getByText('Handed 3 Sessions to Agent Commander')).toBeVisible();

        const after = await pageRequest<{ sessions: Array<{ id: string; displayTitle: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const imported = after.sessions.find(
            ({ displayTitle }) => displayTitle === CONVERSATION_TITLE,
        );
        expect(imported).toBeDefined();
        const managed = await pageRequest<{ sessionIds: string[] }>(
            running.page,
            'commander.managedSessions',
        );
        expect(new Set(managed.sessionIds)).toEqual(new Set([...ownSessionIds, imported!.id]));
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
