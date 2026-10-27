import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { solarizedLightTheme } from '@caxri/protocol';
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
 * The status bar's `N need you` chip counts open Bot Inbox items, so a click must put those items on screen: the The
 * Caxri Bot window comes forward with its Inbox open, a drawer in a narrow window, and the first item focused. The
 * Inbox may have been hidden from the title bar, and the window may not be open at all.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the status bar Needs you chip opens the Bot Inbox on its first item', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-inbox-chip-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    /**
     * The focus indicator as the user sees it: a 2px accent outline, not just a recolored 1px border.
     */
    const focusOutline = (item: ReturnType<Page['locator']>) =>
        item.evaluate((element) => {
            const style = getComputedStyle(element);
            const probe = document.createElement('span');
            probe.style.color = 'var(--accent)';
            document.body.append(probe);
            const accent = getComputedStyle(probe).color;
            probe.remove();
            return {
                isAccent: style.outlineColor === accent,
                style: style.outlineStyle,
                width: style.outlineWidth,
            };
        });
    const botWindow = async (): Promise<Page> => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        // Added one after the other so the newest item, listed first, is deterministic.
        await pageRequest(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Which database should the import use?',
        });
        await pageRequest(running.page, 'bot.inbox.add', {
            kind: 'decision',
            title: 'Approve the release?',
        });
        const chip = running.page.locator('.bot-inbox-chip');
        await expect(chip).toHaveText('2 need you');
        await expect(chip).toHaveAccessibleName(/^Open Inbox: 2 Caxri Bot items/u);

        // Narrow enough that the Inbox overlays the Terminal as a drawer, with the Inbox hidden from the title bar.
        await pageRequest(running.page, 'caxriBot.open');
        let bot = await botWindow();
        await bot.setViewportSize({ width: 900, height: 700 });
        // The toggle's name also carries the open item count, as "Needs you 2".
        const inboxToggle = bot.getByRole('button', { name: /^Needs you/u });
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'true');
        await inboxToggle.click();
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(bot.locator('.caxri-bot-inbox')).toHaveCount(0);

        await chip.click();
        const firstItem = bot.locator('.bot-inbox-item').first();
        await expect(bot.locator('.caxri-bot-inbox')).toBeVisible();
        await expect(inboxToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(firstItem).toBeFocused();
        expect(await focusOutline(firstItem)).toEqual({
            isAccent: true,
            style: 'solid',
            width: '2px',
        });
        await bot.screenshot({ path: testInfo.outputPath('inbox-chip-narrow-drawer.png') });

        // A pointer click focuses an item without the keyboard ring.
        const secondItem = bot.locator('.bot-inbox-item').nth(1);
        await secondItem.locator('span').first().click();
        await expect(secondItem).toBeFocused();
        expect((await focusOutline(secondItem)).style).toBe('none');

        // From a closed window, the request waits for the new window to listen and still lands on the first item.
        await bot.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await chip.click();
        bot = await botWindow();
        await expect(bot.locator('.caxri-bot-inbox')).toBeVisible();
        await expect(bot.locator('.bot-inbox-item').first()).toBeFocused();
        await bot.screenshot({ path: testInfo.outputPath('inbox-chip-reopened.png') });

        // The focus outline stays distinct from the reply target's raised fill when one item is both, in a light theme.
        await pageRequest(running.page, 'theme.update', {
            source: JSON.stringify(solarizedLightTheme),
        });
        const firstReopened = bot.locator('.bot-inbox-item').first();
        await firstReopened.locator('.bot-inbox-reply').click();
        await expect(firstReopened).toHaveAttribute('data-inbox-target', 'true');
        await chip.click();
        await expect(firstReopened).toBeFocused();
        expect(await focusOutline(firstReopened)).toEqual({
            isAccent: true,
            style: 'solid',
            width: '2px',
        });
        await bot.screenshot({
            path: testInfo.outputPath('inbox-chip-light-reply-target.png'),
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
