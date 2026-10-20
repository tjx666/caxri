import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

/**
 * Session tab tear-off (docs/open-sessions.md, "Windows"): dragging an Open Session tab out of every window opens a new
 * Workbench window that owns that Session. Synthetic HTML drag events drive the product handlers, as in
 * `session-tabs.e2e.ts`; the release point is a screen coordinate outside the source window.
 */
interface WindowSessions {
    openSessionIds: string[];
    selectedSessionId?: string;
}

function windowSessions(page: Page): Promise<WindowSessions> {
    return pageRequest<WindowSessions>(page, 'app.bootstrap');
}

async function openSessionIds(page: Page): Promise<string[]> {
    return (await windowSessions(page)).openSessionIds;
}

function stripOrder(page: Page): Promise<string[]> {
    return page
        .locator('[data-session-tab-strip] [data-session-tab-id]')
        .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.sessionTabId ?? ''));
}

async function openInNewTab(page: Page, sessionId: string): Promise<void> {
    await sessionCard(page, sessionId).click({ modifiers: ['Meta'] });
}

/**
 * Starts a drag on a tab and ends it with the given `dropEffect` at a screen point relative to the window's outer
 * bounds: `outside` is just right of the window, `inside` is within it.
 */
async function dragTabOut(
    page: Page,
    sessionId: string,
    options: { dropEffect: 'move' | 'none'; where: 'inside' | 'outside' },
): Promise<void> {
    await page.evaluate(
        ({ sessionId, dropEffect, where }) => {
            const tab = document.querySelector<HTMLElement>(
                `[data-session-tab-id="${CSS.escape(sessionId)}"]`,
            );
            if (!tab) throw new Error('Session tab drag fixture missing');
            const transfer = new DataTransfer();
            const fire = (type: string, point: { x: number; y: number }): void => {
                tab.dispatchEvent(
                    new DragEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: transfer,
                        screenX: point.x,
                        screenY: point.y,
                    }),
                );
            };
            fire('dragstart', { x: window.screenX + 100, y: window.screenY + 20 });
            // The product sets `dropEffect` to `move` over its own strip; an outside release leaves it `none`.
            transfer.dropEffect = dropEffect;
            fire(
                'dragend',
                where === 'outside'
                    ? { x: window.screenX + window.outerWidth + 60, y: window.screenY + 120 }
                    : { x: window.screenX + 200, y: window.screenY + 200 },
            );
        },
        { sessionId, ...options },
    );
}

test('a tab released outside every window opens a new window that owns the Session', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-tear-off-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    const { page } = running;
    try {
        await createShellSession(page);
        const a = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const b = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const c = await selectedSessionId(page);
        await openInNewTab(page, a);
        await openInNewTab(page, b);
        await expect.poll(() => stripOrder(page)).toHaveLength(3);
        expect(running.app.windows()).toHaveLength(1);

        // Negative cases first: a drop that the product accepted (`move`) or that ended inside the window opens nothing.
        await dragTabOut(page, b, { dropEffect: 'move', where: 'outside' });
        await dragTabOut(page, b, { dropEffect: 'none', where: 'inside' });
        await page.waitForTimeout(500);
        expect(running.app.windows()).toHaveLength(1);
        expect(await stripOrder(page)).toHaveLength(3);

        // (1) Releasing outside the window tears the tab off.
        await dragTabOut(page, b, { dropEffect: 'none', where: 'outside' });
        await expect.poll(() => running.app.windows().length).toBe(2);
        const torn = running.app.windows().find((window) => window !== page)!;
        await expect.poll(() => openSessionIds(torn)).toEqual([b]);
        await expect.poll(async () => (await windowSessions(page)).openSessionIds).toHaveLength(2);
        expect((await windowSessions(page)).openSessionIds).not.toContain(b);
        await expect.poll(() => selectedSessionId(torn)).toBe(b);

        // (2) The Session belongs to the new window: selecting it from the source window leaves the source as it was and
        // activates the Session in its owner.
        const sourceSelected = await selectedSessionId(page);
        await sessionCard(page, b).click();
        await expect.poll(() => selectedSessionId(page)).toBe(sourceSelected);
        expect((await windowSessions(page)).openSessionIds).not.toContain(b);
        await openInNewTab(page, b);
        expect((await windowSessions(page)).openSessionIds).not.toContain(b);
        expect((await windowSessions(torn)).openSessionIds).toEqual([b]);

        // (3) The source window keeps its other tabs.
        const remaining = (await windowSessions(page)).openSessionIds;
        expect(remaining).toHaveLength(2);
        expect(new Set(remaining)).toEqual(new Set([a, c]));

        // (4) Closing the torn-off window releases its Open Sessions without archiving the Session.
        await torn.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(sessionCard(page, b)).toBeVisible();
        await sessionCard(page, b).click();
        await expect.poll(() => selectedSessionId(page)).toBe(b);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('torn-off windows survive a restart and come back with their Session', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-tear-off-restart-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const a = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const b = await selectedSessionId(running.page);
        await openInNewTab(running.page, a);
        await expect.poll(() => stripOrder(running.page)).toHaveLength(2);

        await dragTabOut(running.page, b, { dropEffect: 'none', where: 'outside' });
        await expect.poll(() => running.app.windows().length).toBe(2);

        // A real quit keeps the torn-off window's strip stored; the next launch reopens it with the same Session.
        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect.poll(() => running.app.windows().length).toBe(2);
        const restored = running.app.windows().find((window) => window !== running.page)!;
        await expect.poll(() => openSessionIds(restored)).toEqual([b]);
        expect((await windowSessions(running.page)).openSessionIds).not.toContain(b);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
