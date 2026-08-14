import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';

import { createFakeAgentMode } from './support/agent-fixture.ts';
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

test('Session attention persists until the selected Session is visibly focused', async () => {
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
                executableSource: `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'claude-test 1.0\\n'
  exit 0
fi
printf 'Fake Claude ready\\n'
while true; do
  if [ -f "$CLAUDE_CONFIG_DIR/trigger" ]; then
    /bin/rm -f "$CLAUDE_CONFIG_DIR/trigger"
    printf 'metadata changed\\n'
  fi
  sleep 0.05
done
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
        const selectedBeforeHover = await pageRequest<{ selectedSessionId?: string }>(
            running.page,
            'app.bootstrap',
        );
        await firstRow.hover();
        const activityCard = running.page.locator('.session-activity-card');
        await expect(activityCard).toBeVisible();
        await expect(activityCard.locator('h3')).toHaveText(longTitle);
        await expect(activityCard).toContainText('project · Claude Code');
        await expect(activityCard).toContainText('Working');
        await expect(activityCard).toContainText('The Agent is running.');
        await expect(activityCard).toContainText('Last opened');
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

        await createAdditionalShellSession(running.page);
        const withSecond = await pageRequest<{
            selectedSessionId: string;
            sessions: SessionSummary[];
        }>(running.page, 'app.bootstrap');
        const secondSessionId = withSecond.selectedSessionId;
        expect(secondSessionId).not.toBe(firstSession.id);

        await writeClaudeMetadata(config, root, startedAt, 'idle', 'First Agent');
        await expect(firstRow.getByRole('img', { name: 'Unread: Waiting for you' })).toBeVisible();
        await expect(
            firstRow.getByRole('img', {
                name: 'Waiting for you. The Agent is waiting for input or confirmation.',
                exact: true,
            }),
        ).toBeVisible();
        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('ArrowDown');
        await expect(firstRow).toBeFocused();
        await expect(activityCard).toBeVisible({ timeout: 200 });
        await expect(activityCard).toContainText('Waiting for you');
        await expect(activityCard).toContainText('The Agent is waiting for input or confirmation.');
        await expect(activityCard).toContainText('Unread attention: Waiting for you');
        expect(
            (await pageRequest<{ selectedSessionId?: string }>(running.page, 'app.bootstrap'))
                .selectedSessionId,
        ).toBe(secondSessionId);
        await running.page.keyboard.press('Escape');
        await expect(activityCard).toBeHidden();
        await expect(firstRow).toBeFocused();
        /** Outlasts PreviewCard's hover delay so a leaked focus timer cannot reopen the card. */
        await running.page.waitForTimeout(600);
        await expect(activityCard).toBeHidden();
        await expect(firstRow).toBeFocused();

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Waiting for you' }),
        ).toBeVisible();

        await running.page
            .getByRole('button', { name: /^Open Process Explorer — Terminal memory:/ })
            .click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');
        await expect.poll(() => processPage.evaluate(() => document.hasFocus())).toBe(true);
        /** Playwright focus emulation reports both Electron pages as focused; align the main
            document with the real native focus owner while Process Explorer is in front. */
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
                .getByRole('img', { name: 'Unread: Waiting for you' }),
        ).toBeVisible();

        await running.page.evaluate(() => Reflect.deleteProperty(document, 'hasFocus'));
        await running.page.bringToFront();
        await running.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
            .poll(() =>
                running.page.evaluate(
                    () => document.visibilityState === 'visible' && document.hasFocus(),
                ),
            )
            .toBe(true);
        await expect(
            running.page.locator(`[data-session-id="${firstSession.id}"] .session-unread`),
        ).toHaveCount(0);

        await pageRequest(running.page, 'session.select', { sessionId: secondSessionId });
        await writeClaudeMetadata(config, root, startedAt, 'completed', 'First Agent');
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Finished' }),
        ).toBeVisible();

        await running.app.close();
        running = await launchCaxri(launchOptions);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Finished' }),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
