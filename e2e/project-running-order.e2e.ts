import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * Starts a long fake Codex turn in the visible Session, so its Project has a running Agent until the turn is stopped.
 */
async function startRunningChat(page: Page): Promise<void> {
    await openAgentChat(page, 'Codex Chat');
    const chat = page.locator(VISIBLE_SESSION);
    const message = chat.getByRole('textbox', { name: 'Message' });
    await message.fill('slow please');
    await message.press('Enter');
    await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
        'data-workbench-session-id',
        sessionId,
    );
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Projects with a running Agent move above idle Projects in the order their work started', async ({}, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-project-running-'));
    const directory = await realpath(temporary);
    const userData = join(directory, 'user-data');
    const roots = ['alpha', 'beta', 'gamma'].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
        testRootPath: roots[0],
        userDataDir: userData,
    });
    const { page } = running;
    const projectTitles = () => page.locator('.project-select strong').allTextContents();
    try {
        await createProjectSession(page, 'shell');
        const betaSessionId = await createProjectSession(page, 'shell');
        const gammaSessionId = await createProjectSession(page, 'shell');
        await expect.poll(projectTitles).toEqual(['alpha', 'beta', 'gamma']);

        // The first Project to start running rises to the top.
        await startRunningChat(page);
        await expect.poll(projectTitles).toEqual(['gamma', 'alpha', 'beta']);

        // A second one lands after the Project already running, not above it.
        await selectSession(page, betaSessionId);
        await startRunningChat(page);
        await expect.poll(projectTitles).toEqual(['gamma', 'beta', 'alpha']);
        await page.screenshot({ path: testInfo.outputPath('two-running-projects.png') });

        // Once its Agent stops, a Project falls back below the running ones, to the top of the idle Projects.
        await selectSession(page, gammaSessionId);
        await page
            .locator(VISIBLE_SESSION)
            .getByRole('button', { name: 'Stop', exact: true })
            .click();
        await expect.poll(projectTitles).toEqual(['beta', 'gamma', 'alpha']);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
