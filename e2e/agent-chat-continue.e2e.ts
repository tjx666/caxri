import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

/**
 * Where the composer's primary action sits, how large its glyph is, and what fills it, plus the composer's height, so
 * one state can be compared with another.
 */
function primaryAction(button: Locator) {
    return button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const glyph = element.querySelector('svg')?.getBoundingClientRect();
        const composer = element.closest('form')?.getBoundingClientRect();
        return {
            background: getComputedStyle(element).backgroundColor,
            composerHeight: composer?.height,
            glyph: glyph && { height: glyph.height, width: glyph.width },
            slot: { height: box.height, width: box.width, x: box.x, y: box.y },
        };
    });
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Continue after a stopped turn is a quiet play button in the same slot as Send and Stop, and sends Continue', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-continue-'));
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
        const send = chat.getByRole('button', { name: 'Send', exact: true });
        const stop = chat.getByRole('button', { name: 'Stop', exact: true });
        const resume = chat.getByRole('button', { name: 'Continue', exact: true });

        await message.fill('slow one');
        const sendState = await primaryAction(send);
        expect(sendState.slot).toMatchObject({ height: 28, width: 28 });
        await message.press('Enter');
        await expect(stop).toBeVisible();
        const stopState = await primaryAction(stop);

        // A typed message while the turn runs turns Stop into Steer; holding Cmd turns that into the accent Queue.
        await message.fill('steer this');
        const steerState = await primaryAction(chat.getByRole('button', { name: 'Steer message' }));
        await page.keyboard.down('Meta');
        const queue = chat.getByRole('button', { name: 'Queue message', exact: true });
        await expect(queue).toBeVisible();
        const queueState = await primaryAction(queue);
        await page.keyboard.up('Meta');
        await message.fill('');

        await stop.click();
        await expect(resume).toBeVisible({ timeout: 15_000 });
        // The glyph animates in from a smaller scale; measure it at rest.
        await expect
            .poll(async () => (await primaryAction(resume)).glyph?.width)
            .toBeCloseTo(12, 0);
        const resumeState = await primaryAction(resume);
        await page.screenshot({ path: testInfo.outputPath('continue-resting.png') });

        // Continue keeps Send's 28px slot and neutral fill; its filled play glyph is smaller than the 16px arrows.
        expect(resumeState.slot).toEqual(sendState.slot);
        expect(stopState.slot).toEqual(sendState.slot);
        expect(steerState.slot).toEqual(sendState.slot);
        expect(queueState.slot).toEqual(sendState.slot);
        expect(resumeState.composerHeight).toBe(sendState.composerHeight);
        expect(stopState.composerHeight).toBe(sendState.composerHeight);
        expect(resumeState.background).toBe(sendState.background);
        expect(steerState.background).toBe(sendState.background);
        expect(queueState.background).not.toBe(sendState.background);
        expect(sendState.glyph?.width).toBeCloseTo(16, 0);
        expect(resumeState.glyph?.height).toBeCloseTo(12, 0);

        // A click sends the ordinary `Continue` message and starts the next turn.
        await resume.click();
        await expect(chat.getByRole('log').getByText('Continue', { exact: true })).toBeVisible();
        await expect(resume).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
