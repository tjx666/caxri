import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

type ScrollProbeWindow = typeof globalThis & { chatScrollEvents?: number };

/**
 * Counts every `scroll` event the transcript fires from now on. A switch back to a kept-alive Session must not fire
 * any: the Chat is shown where it was, not re-scrolled there.
 */
async function countTranscriptScrolls(transcript: Locator): Promise<void> {
    await transcript.evaluate((element) => {
        const probe = globalThis as ScrollProbeWindow;
        probe.chatScrollEvents = 0;
        element.addEventListener('scroll', () => {
            probe.chatScrollEvents = (probe.chatScrollEvents ?? 0) + 1;
        });
    });
}

function transcriptScrolls(page: Page): Promise<number> {
    return page.evaluate(() => (globalThis as ScrollProbeWindow).chatScrollEvents ?? 0);
}

async function switchTo(page: Page, sessionId: string): Promise<void> {
    await sessionCard(page, sessionId).click();
    await expect.poll(() => selectedSessionId(page)).toBe(sessionId);
    await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
        'data-workbench-session-id',
        sessionId,
    );
    // Two presented frames, so a scroll the switch caused has fired by the time the caller reads the counter.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
    );
}

interface SwitchFrame {
    isShown: boolean;
    hasPlaceholder: boolean;
    turns: number;
}

/**
 * Clicks the Session's card and samples every presented frame until the Chat shows real turns and no placeholder: per
 * frame, whether the Session is shown, whether the transcript draws placeholder turns, and how many user turns it has.
 */
function sampleSwitchFrames(page: Page, chatSessionId: string): Promise<SwitchFrame[]> {
    return page.evaluate(async (sessionId) => {
        const samples: SwitchFrame[] = [];
        document
            .querySelector<HTMLElement>(`.session-card[data-session-id="${CSS.escape(sessionId)}"]`)
            ?.click();
        for (let frame = 0; frame < 600; frame += 1) {
            // eslint-disable-next-line no-await-in-loop -- one sample per presented frame
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const session = document.querySelector(
                `.workbench-session[data-workbench-session-id="${CSS.escape(sessionId)}"]`,
            );
            const log = session?.querySelector('[role="log"]');
            const sample = {
                isShown: Boolean(session && !session.hasAttribute('hidden')),
                hasPlaceholder: Boolean(
                    log?.querySelector(
                        ':scope [role="status"][aria-busy="true"] [data-slot="skeleton"]',
                    ),
                ),
                turns: log?.querySelectorAll('[data-agent-chat-user-message]').length ?? 0,
            };
            samples.push(sample);
            if (sample.turns > 0 && !sample.hasPlaceholder) break;
        }
        return samples;
    }, chatSessionId);
}

/**
 * A Session switch shows the Chat the user left, at the line they were reading, and a Chat whose conversation is not
 * loaded yet shows placeholder turns rather than a blank transcript that reads as an empty conversation.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('switching Sessions keeps each Chat where the user left it and never shows a blank transcript', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-chat-continuity-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        const chatSessionId = await selectedSessionId(page);
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(`[data-workbench-session-id="${chatSessionId}"]`);
        const message = chat.getByRole('textbox', { name: 'Message' });
        // A Session off screen is out of the accessibility tree, and the transcript is also probed while hidden.
        const transcript = chat.getByRole('log', { includeHidden: true });
        // Three long replies, so the transcript is several screens tall and has a middle to read from.
        for (let count = 1; count <= 3; count += 1) {
            // eslint-disable-next-line no-await-in-loop -- each reply must finish before the next message is accepted
            await message.fill('table please');
            // eslint-disable-next-line no-await-in-loop -- see above
            await message.press('Enter');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(chat.getByRole('table')).toHaveCount(count);
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        }
        const reading = await transcript.evaluate((element) => {
            element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
            return element.scrollTop;
        });
        expect(reading).toBeGreaterThan(0);

        await createAdditionalShellSession(page);
        const shellSessionId = await selectedSessionId(page);
        await countTranscriptScrolls(transcript);
        await switchTo(page, chatSessionId);
        await page.screenshot({ path: testInfo.outputPath('chat-kept-reading-position.png') });
        expect(await transcript.evaluate((element) => element.scrollTop)).toBe(reading);
        expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await transcriptScrolls(page)).toBe(0);

        // A Chat following the latest reply comes back at the end without re-scrolling there.
        await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect
            .poll(() =>
                transcript.evaluate(
                    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
                ),
            )
            .toBeLessThan(2);
        await switchTo(page, shellSessionId);
        await countTranscriptScrolls(transcript);
        await switchTo(page, chatSessionId);
        expect(
            await transcript.evaluate(
                (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
        ).toBeLessThan(2);
        expect(await transcriptScrolls(page)).toBe(0);

        /**
         * A reload empties the Renderer's Chat cache, so switching to the Chat reads its conversation again. Every
         * frame from the one that shows the Session draws either placeholder turns or the real ones.
         */
        await switchTo(page, shellSessionId);
        await page.reload();
        await expect(sessionCard(page, chatSessionId)).toBeVisible();
        await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
            'data-workbench-session-id',
            shellSessionId,
        );
        const frames = await sampleSwitchFrames(page, chatSessionId);
        const shown = frames.filter((frame) => frame.isShown);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.filter((frame) => !frame.hasPlaceholder && frame.turns === 0)).toEqual([]);
        expect(shown.at(-1)?.hasPlaceholder).toBe(false);
        expect(shown.at(-1)?.turns).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath('chat-loaded-after-reload.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * After a restart the Chat's Codex is not running, so switching to it resumes the thread, and Codex replays the history
 * only once it answers `thread/resume`. Until then the transcript draws placeholder turns, not a blank pane under the
 * "Starting Codex" status line.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Chat whose Codex is still resuming shows placeholder turns, not a blank transcript', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-chat-resume-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    let running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        const chatSessionId = await selectedSessionId(page);
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(`[data-workbench-session-id="${chatSessionId}"]`);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.getByRole('table')).toHaveCount(1);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
        await createAdditionalShellSession(page);
        const shellSessionId = await selectedSessionId(page);
        await closeAppQuietly(running.app);

        await writeFile(join(directory, 'codex-threads', 'resume-delay-ms'), '2000');
        running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
        const relaunched = running.page;
        await expect(sessionCard(relaunched, chatSessionId)).toBeVisible();
        await expect(relaunched.locator(VISIBLE_SESSION)).toHaveAttribute(
            'data-workbench-session-id',
            shellSessionId,
        );
        const frames = await sampleSwitchFrames(relaunched, chatSessionId);
        const shown = frames.filter((frame) => frame.isShown);
        expect(shown.filter((frame) => !frame.hasPlaceholder && frame.turns === 0)).toEqual([]);
        expect(shown.filter((frame) => frame.hasPlaceholder).length).toBeGreaterThan(10);
        expect(shown.at(-1)?.hasPlaceholder).toBe(false);
        expect(shown.at(-1)?.turns).toBeGreaterThan(0);
        await relaunched.screenshot({ path: testInfo.outputPath('chat-resumed.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
