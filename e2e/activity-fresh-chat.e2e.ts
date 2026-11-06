import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatExecutableSource } from '../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { fakeCodexChatProvider } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    VISIBLE_SESSION,
} from './support/helpers.ts';

interface Bootstrap {
    projects: Array<{ id: string; rootPath: string }>;
    sessions: Array<{ id: string; projectId: string }>;
    terminals: Array<{ id: string; kind: string; sessionId: string; surface?: string }>;
}

/**
 * The Activity view's New Session press opens a fresh Chat at once; until its first message the Chat can move to
 * another Project or Agent, and leaving it empty discards it. Only a real launch proves the Renderer's fresh-Chat
 * bookkeeping, the empty state's picker, and Server Core's `session.discardIfEmpty` agree end to end.
 */
test('Activity New Session opens a fresh Chat that moves before its first message and is discarded when left empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-activity-fresh-chat-'));
    const userData = join(directory, 'user-data');
    const roots = ['alpha', 'beta'].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { executableSource: fakeClaudeChatExecutableSource({}) },
            codex: fakeCodexChatProvider(directory, join(userData, 'e2e-agents', 'codex')),
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    });
    try {
        const { page } = running;
        const shellSessionId = await createProjectSession(page, 'shell');
        const root = await pageRequest<string | null>(page, 'dialog.selectDirectory');
        if (root !== roots[1]) throw new Error('Unexpected second Project root');
        const beta = await pageRequest<{ id: string }>(page, 'project.create', { rootPath: root });
        await pageRequest(page, 'session.select', { sessionId: shellSessionId });
        await pageRequest(page, 'settings.update', {
            source: JSON.stringify({
                'session.defaultAgent': 'claude',
                'session.openAgentsInChat': true,
            }),
        });
        const bootstrap = () => pageRequest<Bootstrap>(page, 'app.bootstrap');

        await page.locator('.primary-sidebar-activity-toggle').click();
        await expect(page.getByRole('tree', { name: 'Activity' })).toBeVisible();

        // A1: the press opens an empty Chat right away, with no menu, offering where and with whom to start.
        await page.locator('.agent-activity-new-session').click();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect.poll(() => selectedSessionId(page)).not.toBe(shellSessionId);
        const firstFreshId = await selectedSessionId(page);
        const session = page.locator(VISIBLE_SESSION);
        const target = session.locator('[data-fresh-chat-target]');
        await expect(target).toBeVisible();
        await expect(target.locator('[data-fresh-chat-agent]')).toHaveText('Claude');
        await expect(session.getByRole('textbox', { name: 'Message' })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('fresh-chat-empty.png') });

        // A2: choosing another Project replaces the empty Session with one there.
        await target.locator('[data-fresh-chat-project]').click();
        await page
            .getByRole('menu', { name: 'Choose a Project for this Session' })
            .getByRole('menuitem', { name: 'beta' })
            .click();
        await expect.poll(() => selectedSessionId(page)).not.toBe(firstFreshId);
        const movedId = await selectedSessionId(page);
        await expect
            .poll(async () => (await bootstrap()).sessions.some(({ id }) => id === firstFreshId))
            .toBe(false);
        const moved = (await bootstrap()).sessions.find(({ id }) => id === movedId);
        expect(moved?.projectId).toBe(beta.id);
        await expect(page.locator(VISIBLE_SESSION).locator('[data-fresh-chat-project]')).toHaveText(
            'beta',
        );

        // Choosing another Agent does the same, keeping the Project.
        await page.locator(VISIBLE_SESSION).locator('[data-fresh-chat-agent]').click();
        await page
            .getByRole('menu', { name: 'Choose an Agent for this Session' })
            .getByRole('menuitem', { name: 'Codex' })
            .click();
        await expect.poll(() => selectedSessionId(page)).not.toBe(movedId);
        const codexId = await selectedSessionId(page);
        const codex = (await bootstrap()).terminals.find(({ sessionId }) => sessionId === codexId);
        expect(codex?.kind).toBe('codex');
        expect((await bootstrap()).sessions.find(({ id }) => id === codexId)?.projectId).toBe(
            beta.id,
        );

        // A4: leaving the empty Chat discards it and says so.
        await pageRequest(page, 'session.select', { sessionId: shellSessionId });
        await expect(page.getByText('Discarded empty Session')).toBeVisible();
        await expect
            .poll(async () => (await bootstrap()).sessions.some(({ id }) => id === codexId))
            .toBe(false);

        // A3: the first message locks the Chat, and leaving it then keeps it.
        await page.locator('.agent-activity-new-session').click();
        await expect.poll(() => selectedSessionId(page)).not.toBe(shellSessionId);
        const sentId = await selectedSessionId(page);
        const sent = page.locator(VISIBLE_SESSION);
        await expect(sent.locator('[data-fresh-chat-target]')).toBeVisible();
        const message = sent.getByRole('textbox', { name: 'Message' });
        await message.fill('hello there');
        await message.press('Enter');
        await expect(sent.locator('[data-fresh-chat-target]')).toHaveCount(0);
        await pageRequest(page, 'session.select', { sessionId: shellSessionId });
        await expect.poll(() => selectedSessionId(page)).toBe(shellSessionId);
        expect((await bootstrap()).sessions.some(({ id }) => id === sentId)).toBe(true);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
