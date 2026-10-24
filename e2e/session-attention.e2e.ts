import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';

interface SessionSummary {
    attentionEpoch: number;
    hasUnread: boolean;
    id: string;
    lastActivityState: string;
}

async function writeClaudeMetadata(
    configDirectory: string,
    root: string,
    startedAt: number,
    status: 'busy' | 'idle' | 'completed',
    name: string,
): Promise<void> {
    const sessions = join(configDirectory, 'sessions');
    const target = join(sessions, 'session.json');
    const temporary = join(sessions, 'session.next.json');
    await writeFile(
        temporary,
        JSON.stringify({
            cwd: root,
            name,
            sessionId: 'claude-attention-session',
            startedAt: new Date(startedAt).toISOString(),
            status,
            updatedAt: new Date().toISOString(),
        }),
        'utf8',
    );
    await rename(temporary, target);
    await writeFile(join(configDirectory, 'trigger'), String(Date.now()), 'utf8');
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument to use object destructuring.
test('Session attention persists until the selected Session is visibly focused', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-attention-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(join(config, 'sessions'), { recursive: true }),
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
const resumeIndex = process.argv.indexOf('--resume');
const command = process.argv.at(-1) ?? '';
if (resumeIndex >= 0 && command.startsWith('/rename ')) {
  const sessionId = process.argv[resumeIndex + 1];
  const displayTitle = command.slice('/rename '.length);
  const metadataPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions', 'session.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, name: displayTitle }), 'utf8');
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + displayTitle,
    session_id: sessionId,
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}
process.stdout.write('Fake Claude ready\n');
setInterval(() => {
  const trigger = path.join(process.env.CLAUDE_CONFIG_DIR, 'trigger');
  if (!fs.existsSync(trigger)) return;
  fs.rmSync(trigger);
  process.stdout.write('metadata changed\n');
}, 50);
`,
            },
        },
    });
    const launchOptions = {
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible' as const,
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page, 'claude');
        const initial = await pageRequest<{ sessions: SessionSummary[] }>(
            running.page,
            'app.bootstrap',
        );
        const firstSession = initial.sessions[0];
        const startedAt = Date.now();
        await writeClaudeMetadata(config, root, startedAt, 'busy', 'First Agent');
        await expect
            .poll(async () => {
                const state = await pageRequest<{ sessions: SessionSummary[] }>(
                    running.page,
                    'app.bootstrap',
                );
                return state.sessions.find((session) => session.id === firstSession.id)
                    ?.lastActivityState;
            })
            .toBe('running');
        const longTitle = `First Agent ${'with a long explanatory Session title '.repeat(4)}`;
        await pageRequest(running.page, 'session.rename', {
            displayTitle: longTitle,
            sessionId: firstSession.id,
        });

        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.setBounds({ width: 960, height: 640 }),
        );
        const firstRow = running.page.locator(`[data-session-id="${firstSession.id}"]`);
        const firstStatus = firstRow.locator('.session-status');
        await expect(firstStatus).toHaveAttribute('data-session-status', 'running');
        await expect(firstStatus).toHaveAccessibleName('Working');
        await expect(firstStatus).toHaveAccessibleDescription('The Agent is running.');
        expect(
            await firstStatus
                .locator('[data-session-status-arc]')
                .evaluate((element) => element.getAnimations().length),
        ).toBeGreaterThan(0);
        // A monochrome ring, as in Codex's thread list: it strokes in the slot's own muted text color, not a status hue.
        const ringColors = await firstStatus.evaluate((element) => ({
            ring: [...element.querySelectorAll(':scope [data-session-status-arc] circle')].map(
                (circle) => getComputedStyle(circle).stroke,
            ),
            slot: getComputedStyle(element).color,
        }));
        expect(ringColors.ring).toEqual([ringColors.slot]);
        // The row keeps the Agent's brand-color mark: color is what tells Claude Code and Codex apart in a long list.
        await expect(firstRow.locator('img[data-agent-icon="claude"]')).toBeVisible();
        const [rowBox, statusBox] = await Promise.all([
            firstRow.boundingBox(),
            firstStatus.boundingBox(),
        ]);
        if (!rowBox || !statusBox) throw new Error('Session status layout is unavailable');
        // One line per Session, with the lifecycle glyph at the row's right edge.
        expect(rowBox.height).toBe(28);
        expect(rowBox.x + rowBox.width - (statusBox.x + statusBox.width)).toBeLessThanOrEqual(10);
        /**
         * Captured while the Agent is running so the settled assertion further down can prove an empty status track
         * returns the visible glyph's width plus the row gap in front of it to the title: the track hides entirely once
         * it holds nothing (#2303), because a zero-width flex item would still cost that gap.
         */
        const runningStatusWidth =
            statusBox.width +
            (await firstRow.evaluate((element) =>
                Number(getComputedStyle(element).columnGap.replace(/px$/u, '')),
            ));
        const runningTitleWidth = await firstRow
            .locator('.session-copy')
            .evaluate((element) => element.getBoundingClientRect().width);
        const selectedBeforeHover = await pageRequest<{ selectedSessionId?: string }>(
            running.page,
            'app.bootstrap',
        );
        await firstRow.hover();
        const archiveButton = running.page.getByRole('button', { name: `Archive ${longTitle}` });
        await expect(archiveButton).toBeVisible();
        /**
         * The hover affordance lives on the container holding the row's actions rather than on each button, so opacity
         * is asserted there: a button inside an `opacity: 0` parent still computes its own opacity as 1.
         */
        const rowActions = running.page
            .locator('.session-row')
            .filter({ has: running.page.locator(`[data-session-id="${firstSession.id}"]`) })
            .locator('.session-row-actions');
        await expect(rowActions).toHaveCSS('opacity', '1');
        await expect(rowActions).toHaveCSS('pointer-events', 'auto');
        /**
         * The hover actions take the right edge. A running glyph is what the user hovers a busy row to check, so it
         * stays visible and moves left of the actions instead of fading out under them.
         */
        await expect(firstStatus).toHaveCSS('opacity', '1');
        const [hoveredStatusBox, rowActionsBox] = await Promise.all([
            firstStatus.boundingBox(),
            rowActions.boundingBox(),
        ]);
        if (!hoveredStatusBox || !rowActionsBox)
            throw new Error('Session row geometry is unavailable');
        expect(hoveredStatusBox.x + hoveredStatusBox.width).toBeLessThanOrEqual(rowActionsBox.x);
        const activityCard = running.page.locator('.session-activity-card');
        await expect(activityCard).toBeVisible();
        await expect(activityCard.locator('h3')).toHaveText(longTitle);
        await expect(activityCard).toContainText('project · Claude');
        await expect(activityCard).toContainText('Working');
        // A running Agent's sentence only restates the label, so the card leaves it to the accessible description.
        await expect(activityCard).not.toContainText('The Agent is running.');
        await expect(activityCard).toContainText('Opened');
        const cardPosition = await running.page.evaluate(() => {
            const trigger = document.querySelector<HTMLElement>('.session-card');
            const card = document.querySelector<HTMLElement>('.session-activity-card');
            if (!trigger || !card) throw new Error('Session activity card is unavailable');
            const triggerRect = trigger.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            return {
                card: {
                    bottom: cardRect.bottom,
                    left: cardRect.left,
                    right: cardRect.right,
                    top: cardRect.top,
                },
                trigger: { left: triggerRect.left, right: triggerRect.right },
                viewport: { height: window.innerHeight, width: window.innerWidth },
            };
        });
        expect(cardPosition.card.left).toBeGreaterThanOrEqual(0);
        expect(cardPosition.card.top).toBeGreaterThanOrEqual(0);
        expect(cardPosition.card.right).toBeLessThanOrEqual(cardPosition.viewport.width);
        expect(cardPosition.card.bottom).toBeLessThanOrEqual(cardPosition.viewport.height);
        expect(
            cardPosition.card.left >= cardPosition.trigger.right ||
                cardPosition.card.right <= cardPosition.trigger.left,
        ).toBe(true);
        expect(
            (await pageRequest<{ selectedSessionId?: string }>(running.page, 'app.bootstrap'))
                .selectedSessionId,
        ).toBe(selectedBeforeHover.selectedSessionId);
        await running.page.keyboard.press('Escape');
        await expect(activityCard).toBeHidden();
        await running.page.mouse.move(900, 600);
        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        expect(
            await firstStatus
                .locator('[data-session-status-arc]')
                .evaluate((element) => element.getAnimations().length),
        ).toBe(0);
        await firstRow.evaluate((element) => {
            Object.assign(element.style, {
                bottom: '8px',
                left: 'auto',
                position: 'fixed',
                right: '8px',
                top: 'auto',
                width: '220px',
                zIndex: '70',
            });
        });
        await firstRow.hover();
        await expect(activityCard).toBeVisible();
        const edgePosition = await running.page.evaluate(() => {
            const trigger = document.querySelector<HTMLElement>('.session-card');
            const card = document.querySelector<HTMLElement>('.session-activity-card');
            if (!trigger || !card) throw new Error('Session activity card is unavailable');
            const triggerRect = trigger.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            return {
                card: {
                    bottom: cardRect.bottom,
                    left: cardRect.left,
                    right: cardRect.right,
                    top: cardRect.top,
                },
                trigger: { left: triggerRect.left, top: triggerRect.top },
                viewport: { height: window.innerHeight, width: window.innerWidth },
            };
        });
        expect(edgePosition.card.right).toBeLessThanOrEqual(edgePosition.trigger.left);
        expect(edgePosition.card.top).toBeLessThan(edgePosition.trigger.top);
        expect(edgePosition.card.left).toBeGreaterThanOrEqual(0);
        expect(edgePosition.card.top).toBeGreaterThanOrEqual(0);
        expect(edgePosition.card.right).toBeLessThanOrEqual(edgePosition.viewport.width);
        expect(edgePosition.card.bottom).toBeLessThanOrEqual(edgePosition.viewport.height);
        expect(await activityCard.evaluate((element) => element.getAnimations().length)).toBe(0);
        await running.page.keyboard.press('Escape');
        await expect(activityCard).toBeHidden();
        await firstRow.evaluate((element) => element.removeAttribute('style'));
        await running.page.mouse.move(900, 600);
        await running.page.emulateMedia({ reducedMotion: 'no-preference' });

        await createAdditionalShellSession(running.page);
        const withSecond = await pageRequest<{
            selectedSessionId: string;
            sessions: SessionSummary[];
        }>(running.page, 'app.bootstrap');
        const secondSessionId = withSecond.selectedSessionId;
        expect(secondSessionId).not.toBe(firstSession.id);
        await expect
            .poll(() =>
                running.page
                    .locator('.session-card')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([secondSessionId, firstSession.id]);

        await writeClaudeMetadata(config, root, startedAt, 'idle', 'First Agent');
        await expect(firstStatus).toHaveAttribute('data-session-status', 'attention');
        await expect(firstStatus).toHaveAttribute('data-attention-kind', 'completed');
        await expect(firstStatus).toHaveAttribute('data-attention-variant', 'result');
        await expect(firstStatus).toHaveAccessibleName('Unread, finished');
        await expect(firstStatus).toHaveAccessibleDescription(
            'The Agent finished its latest turn.',
        );
        expect(
            await firstStatus
                .locator('[data-session-status-ripple]')
                .evaluate((element) => element.getAnimations().length),
        ).toBeGreaterThan(0);
        const secondRow = running.page.locator(`[data-session-id="${secondSessionId}"]`);
        expect(
            await firstRow
                .locator('strong')
                .evaluate((element) => getComputedStyle(element).fontWeight),
        ).toBe(
            await secondRow
                .locator('strong')
                .evaluate((element) => getComputedStyle(element).fontWeight),
        );
        await expect
            .poll(() =>
                running.page
                    .locator('.session-card')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([firstSession.id, secondSessionId]);
        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('ArrowDown');
        await expect(firstRow).toBeFocused();
        await expect(firstStatus).toBeVisible();
        await expect(rowActions).toHaveCSS('opacity', '0');
        await expect(rowActions).toHaveCSS('pointer-events', 'none');
        await expect(activityCard).toBeVisible({ timeout: 200 });
        await expect(activityCard).toContainText('Finished');
        await expect(activityCard).not.toContainText('The Agent finished its latest turn.');
        await expect(activityCard).toContainText('Unread attention: Finished');
        expect(
            (await pageRequest<{ selectedSessionId?: string }>(running.page, 'app.bootstrap'))
                .selectedSessionId,
        ).toBe(secondSessionId);
        await running.page.keyboard.press('Escape');
        await expect(activityCard).toBeHidden();
        await expect(firstRow).toBeFocused();
        /**
         * Outlasts PreviewCard's hover delay so a leaked focus timer cannot reopen the card.
         */
        await running.page.waitForTimeout(600);
        await expect(activityCard).toBeHidden();
        await expect(firstRow).toBeFocused();

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .locator('.session-status[data-session-status="attention"]'),
        ).toBeVisible();

        await running.page
            .getByRole('button', { name: /^Open Process Explorer — Terminal memory:/ })
            .click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');
        await expect.poll(() => processPage.evaluate(() => document.hasFocus())).toBe(true);
        /**
         * Playwright focus emulation reports both Electron pages as focused; align the main document with the real
         * native focus owner while Process Explorer is in front.
         */
        await running.page.evaluate(() =>
            Object.defineProperty(document, 'hasFocus', {
                configurable: true,
                value: () => false,
            }),
        );
        await pageRequest(running.page, 'session.select', { sessionId: firstSession.id });
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .locator('.session-status[data-session-status="attention"]'),
        ).toBeVisible();
        await expect
            .poll(() =>
                running.page
                    .locator('.session-card')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([firstSession.id, secondSessionId]);

        await running.page.evaluate(() => Reflect.deleteProperty(document, 'hasFocus'));
        await running.page.bringToFront();
        await running.page.evaluate(() => dispatchEvent(new Event('focus')));
        await expect
            .poll(() =>
                running.page.evaluate(
                    () => document.visibilityState === 'visible' && document.hasFocus(),
                ),
            )
            .toBe(true);
        const selectedStatus = running.page.locator(
            `[data-session-id="${firstSession.id}"] .session-status`,
        );
        await expect(selectedStatus).toHaveAttribute('data-session-status', 'default');
        await expect(selectedStatus).not.toHaveAttribute('data-attention-kind');
        await running.page.screenshot({
            path: testInfo.outputPath('selected-session-attention-cleared.png'),
        });

        await pageRequest(running.page, 'session.select', { sessionId: secondSessionId });
        await expect
            .poll(() =>
                running.page
                    .locator('.session-card')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([firstSession.id, secondSessionId]);
        /**
         * Losing selection is not new Agent activity. Claude Code leaves `status: "idle"` in its metadata after a turn
         * ends, and a routine probe used to persist that as `waiting` over the acknowledged state, which the
         * PrimarySidebar then rendered as a second static amber cue no amount of reading could clear.
         */
        const deselectedStatus = running.page.locator(
            `[data-session-id="${firstSession.id}"] .session-status`,
        );
        await expect(deselectedStatus).toHaveAttribute('data-session-status', 'default');
        await expect(deselectedStatus).not.toHaveAttribute('data-attention-kind');
        await running.page.waitForTimeout(600);
        await expect(deselectedStatus).toHaveAttribute('data-session-status', 'default');
        expect(await deselectedStatus.evaluate((element) => element.clientWidth)).toBe(0);
        const settledTitleWidth = await running.page
            .locator(`[data-session-id="${firstSession.id}"] .session-copy`)
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(settledTitleWidth - runningTitleWidth).toBe(runningStatusWidth);

        /**
         * A second turn is what earns a second unread generation: a probe can only prove a turn ended for a Session it
         * just observed running, so the Agent has to go busy again first.
         */
        await writeClaudeMetadata(config, root, startedAt, 'busy', 'First Agent');
        await expect(deselectedStatus).toHaveAttribute('data-session-status', 'running');
        await writeClaudeMetadata(config, root, startedAt, 'completed', 'First Agent');
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .locator('.session-status[data-session-status="attention"]'),
        ).toBeVisible();

        await running.app.close();
        running = await launchCaxri(launchOptions);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .locator('.session-status[data-session-status="attention"]'),
        ).toBeVisible();
        await expect
            .poll(() =>
                running.page
                    .locator('.session-card')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([firstSession.id, secondSessionId]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
