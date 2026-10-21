import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

/**
 * The Open Session strip (issue #2216, docs/open-sessions.md): one tab per Session the window has open, shown only from
 * two Open Sessions on. Selectors are the strip's accessible name and its `data-session-tab-id` attribute, never
 * layout.
 */
const STRIP_LABEL = 'Open Sessions';

function tabList(page: Page) {
    return page.getByRole('tablist', { name: STRIP_LABEL });
}

function tabFor(page: Page, sessionId: string) {
    return page.locator(`[data-session-tab-id="${sessionId}"]`);
}

/**
 * Tab Session IDs in strip order; empty while the strip is hidden.
 */
function stripOrder(page: Page): Promise<string[]> {
    return page
        .locator('[data-session-tab-strip] [data-session-tab-id]')
        .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.sessionTabId ?? ''));
}

interface BootstrapSessions {
    openSessionIds: string[];
    selectedSessionId?: string;
    sessions: Array<{ id: string; archivedAt?: unknown }>;
}

function bootstrap(page: Page): Promise<BootstrapSessions> {
    return pageRequest<BootstrapSessions>(page, 'app.bootstrap');
}

/**
 * Cmd+click on a sidebar row: the browser gesture for "open in a new tab".
 */
async function openInNewTab(page: Page, sessionId: string): Promise<void> {
    await sessionCard(page, sessionId).click({ modifiers: ['Meta'] });
}

async function expectSelected(page: Page, sessionId: string): Promise<void> {
    await expect.poll(() => selectedSessionId(page)).toBe(sessionId);
    await expect(sessionCard(page, sessionId)).toHaveAttribute('aria-selected', 'true');
}

test('Open Session tabs open, switch, close, replace, and open next to the active tab without touching Session existence', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-tabs-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    const { page } = running;
    try {
        // (1) One Open Session: no strip.
        await createShellSession(page);
        const a = await selectedSessionId(page);
        await expect(tabList(page)).toHaveCount(0);

        // (6a) Creating Sessions from the sidebar only replaces the Preview entry, so the strip stays hidden however many Sessions exist.
        await createAdditionalShellSession(page);
        const b = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const c = await selectedSessionId(page);
        expect(new Set([a, b, c]).size).toBe(3);
        await expect(tabList(page)).toHaveCount(0);

        // (2) Cmd+click opens a second Session in a new tab; the strip appears with 2 tabs and the new one selected.
        await openInNewTab(page, b);
        await expect(tabList(page)).toBeVisible();
        await expect.poll(() => stripOrder(page)).toHaveLength(2);
        expect(new Set(await stripOrder(page))).toEqual(new Set([c, b]));
        await expectSelected(page, b);
        await expect(tabFor(page, b).getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        await expect(tabFor(page, c).getByRole('tab')).toHaveAttribute('aria-selected', 'false');

        // (3) Cmd+1 / Cmd+2 pick tabs by position and the sidebar selection follows.
        const order = await stripOrder(page);
        await page.keyboard.press('Meta+1');
        await expectSelected(page, order[0]);
        await page.keyboard.press('Meta+2');
        await expectSelected(page, order[1]);
        await page.keyboard.press('Meta+1');
        await expectSelected(page, order[0]);
        expect(await stripOrder(page)).toEqual(order);

        // (4) The close button removes the tab but never archives the Session; one tab left hides the strip.
        await tabFor(page, b).hover();
        await tabFor(page, b)
            .getByRole('button', { name: /^Close / })
            .click();
        await expect(tabList(page)).toHaveCount(0);
        await expect(sessionCard(page, b)).toBeVisible();
        const afterClose = await bootstrap(page);
        expect(afterClose.openSessionIds).toEqual([c]);
        expect(afterClose.sessions.find((session) => session.id === b)).toBeDefined();
        expect(afterClose.sessions.find((session) => session.id === b)?.archivedAt).toBeFalsy();
        await expectSelected(page, c);

        // (5) A plain click on a Session outside the strip replaces only the Preview entry (c, still italic because
        // nothing was typed in it), never the kept tab b that Cmd+click opened.
        await openInNewTab(page, b);
        await expect.poll(() => stripOrder(page)).toHaveLength(2);
        await expect(tabFor(page, c)).toHaveAttribute('data-tab-preview', 'true');
        await expect(tabFor(page, b)).not.toHaveAttribute('data-tab-preview', 'true');
        await sessionCard(page, a).click();
        await expectSelected(page, a);
        await expect.poll(() => stripOrder(page)).toHaveLength(2);
        expect(new Set(await stripOrder(page))).toEqual(new Set([a, b]));
        await expect(tabFor(page, a)).toHaveAttribute('data-tab-preview', 'true');
        // Double-clicking the Preview tab keeps it, so the next plain click adds a Preview tab instead of replacing it.
        await tabFor(page, a).getByRole('tab').dblclick();
        await expect(tabFor(page, a)).not.toHaveAttribute('data-tab-preview', 'true');
        await sessionCard(page, c).click();
        await expectSelected(page, c);
        await expect.poll(() => stripOrder(page)).toHaveLength(3);
        await expect(tabFor(page, c)).toHaveAttribute('data-tab-preview', 'true');
        await tabFor(page, c)
            .getByRole('button', { name: /^Close / })
            .click();
        await expect.poll(() => stripOrder(page)).toHaveLength(2);
        const beforeAppend = await stripOrder(page);

        // (6b) A new Session created from the sidebar leaves the kept tabs alone (it becomes the Preview entry), but the strip's "+" opens a tab right of the active one.
        const sessionsBefore = (await bootstrap(page)).sessions.length;
        await createAdditionalShellSession(page);
        const created = await selectedSessionId(page);
        expect(new Set([a, b, c])).not.toContain(created);
        // No Preview entry is left, so the created Session adds one.
        await expect.poll(() => stripOrder(page)).toHaveLength(beforeAppend.length + 1);
        const activeBeforeNewTab = await selectedSessionId(page);
        const strip = page.locator('[data-session-tab-strip]');
        await strip.getByRole('button', { name: 'New Session', exact: true }).click();
        // Without a default Agent the `+` hangs the Agent list from itself, not from the sidebar's Project heading.
        await chooseTerminalFromCreateMenu(page, 'Shell');
        await expect.poll(() => stripOrder(page)).toHaveLength(beforeAppend.length + 2);
        await expect
            .poll(async () => (await bootstrap(page)).sessions.length)
            .toBe(sessionsBefore + 2);
        // The new tab opens immediately right of the tab that was active, not at the end of the strip.
        const orderAfter = await stripOrder(page);
        const appended = orderAfter[orderAfter.indexOf(activeBeforeNewTab) + 1];
        expect(appended).toBe(await selectedSessionId(page));
        await expectSelected(page, appended);
        await expect(tabFor(page, appended).getByRole('tab')).toHaveAttribute(
            'aria-selected',
            'true',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Synthetic HTML drag events drive the product handlers without taking macOS foreground focus, as
 * `session-order.e2e.ts` does for sidebar rows. The tab dispatches the events; they bubble to the strip's handlers.
 */
async function dragTab(
    page: Page,
    sourceId: string,
    targetId: string,
    edge: 'before' | 'after',
): Promise<void> {
    await page.evaluate(
        ({ sourceId, targetId, edge }) => {
            const find = (id: string): HTMLElement => {
                const tab = document.querySelector<HTMLElement>(
                    `[data-session-tab-id="${CSS.escape(id)}"]`,
                );
                if (!tab) throw new Error('Session tab drag fixture missing');
                return tab;
            };
            const source = find(sourceId);
            const target = find(targetId);
            const transfer = new DataTransfer();
            const fire = (element: HTMLElement, type: string, clientX: number): void => {
                element.dispatchEvent(
                    new DragEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: transfer,
                        clientX,
                    }),
                );
            };
            const sourceBounds = source.getBoundingClientRect();
            fire(source, 'dragstart', sourceBounds.left + 2);
            const bounds = target.getBoundingClientRect();
            const clientX = edge === 'before' ? bounds.left + 2 : bounds.right - 2;
            fire(target, 'dragover', clientX);
            fire(target, 'drop', clientX);
            fire(source, 'dragend', clientX);
        },
        { sourceId, targetId, edge },
    );
}

test('Open Session tabs reorder by drag and the list and order survive a restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-tabs-restart-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const a = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const b = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const c = await selectedSessionId(running.page);

        await openInNewTab(running.page, a);
        await openInNewTab(running.page, b);
        await expect.poll(() => stripOrder(running.page)).toHaveLength(3);
        const initial = await stripOrder(running.page);
        expect(new Set(initial)).toEqual(new Set([a, b, c]));

        // (7) Dragging the first tab past the last one moves it to the end; the others keep their relative order.
        const [first, second, third] = initial as [string, string, string];
        await dragTab(running.page, first, third, 'after');
        await expect.poll(() => stripOrder(running.page)).toEqual([second, third, first]);
        // The reorder is durable on the Server, not only in the strip.
        await expect
            .poll(async () => (await bootstrap(running.page)).openSessionIds)
            .toEqual([second, third, first]);
        const selected = await selectedSessionId(running.page);

        // (8) A real quit and relaunch on the same profile restores the Open Session list, its order, and the active tab.
        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect.poll(() => stripOrder(running.page)).toEqual([second, third, first]);
        await expectSelected(running.page, selected);
        await expect(tabFor(running.page, selected).getByRole('tab')).toHaveAttribute(
            'aria-selected',
            'true',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
