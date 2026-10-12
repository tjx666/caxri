import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createShellSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';

/**
 * The status bar's `N need you` chip counts open Commander Inbox items, so a click must put those items on screen: the
 * Commander window comes forward with its Inbox open, a drawer in a narrow window, and the first item focused. The
 * Inbox may have been hidden from the title bar, and the window may not be open at all.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the status bar Needs you chip opens the Commander Inbox on its first item', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-inbox-chip-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const commanderWindow = async (): Promise<Page> => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        // Added one after the other so the newest item, listed first, is deterministic.
        await pageRequest(running.page, 'commander.inbox.add', {
            kind: 'decision',
            title: 'Which database should the import use?',
        });
        await pageRequest(running.page, 'commander.inbox.add', {
            kind: 'decision',
            title: 'Approve the release?',
        });
        const chip = running.page.locator('.commander-inbox-chip');
        await expect(chip).toHaveText('2 need you');
        await expect(chip).toHaveAccessibleName(/^Open Inbox: 2 Agent Commander items/u);

        // Narrow enough that the Inbox overlays the Terminal as a drawer, with the Inbox hidden from the title bar.
        await pageRequest(running.page, 'agentCommander.open');
        let commander = await commanderWindow();
        await commander.setViewportSize({ width: 900, height: 700 });
        // The toggle's name also carries the open item count, as "Needs you 2".
        const inboxToggle = commander.getByRole('button', { name: /^Needs you/u });
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'true');
        await inboxToggle.click();
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(commander.locator('.agent-commander-inbox')).toHaveCount(0);

        await chip.click();
        const firstItem = commander.locator('.commander-inbox-item').first();
        await expect(commander.locator('.agent-commander-inbox')).toBeVisible();
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(firstItem).toBeFocused();
        await commander.screenshot({ path: testInfo.outputPath('inbox-chip-narrow-drawer.png') });

        // From a closed window, the request waits for the new window to listen and still lands on the first item.
        await commander.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await chip.click();
        commander = await commanderWindow();
        await expect(commander.locator('.agent-commander-inbox')).toBeVisible();
        await expect(commander.locator('.commander-inbox-item').first()).toBeFocused();
        await commander.screenshot({ path: testInfo.outputPath('inbox-chip-reopened.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
