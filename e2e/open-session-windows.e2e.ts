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
import {
    chooseContextMenuItem,
    contextMenuLabels,
    dismissContextMenu,
} from './support/native-context-menu.ts';

/**
 * One-row navigation (issue #2371, docs/open-sessions.md): a window holds only the Session it shows, the sidebar is the
 * only Session switcher, `Cmd+1` to `Cmd+9` reach the Pinned group, and "Open in New Window" on a sidebar row is the
 * one way to show a second Session at the same time.
 */
const OPEN_IN_NEW_WINDOW = 'Open in New Window';

interface WindowSessions {
    openSessionIds: string[];
    selectedSessionId?: string;
}

function windowSessions(page: Page): Promise<WindowSessions> {
    return pageRequest<WindowSessions>(page, 'app.bootstrap');
}

async function expectSelected(page: Page, sessionId: string): Promise<void> {
    await expect.poll(() => selectedSessionId(page)).toBe(sessionId);
    await expect(sessionCard(page, sessionId)).toHaveAttribute('aria-selected', 'true');
}

async function rowMenuLabels(
    page: Page,
    app: Parameters<typeof contextMenuLabels>[0],
    sessionId: string,
) {
    await sessionCard(page, sessionId).click({ button: 'right' });
    return contextMenuLabels(app);
}

test('sidebar clicks keep one Open Session per window and Cmd+number switches Pinned Sessions', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-one-row-e2e-'));
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

        // (1) Plain and Cmd clicks only switch: the window never collects a second Open Session, so no strip exists.
        await sessionCard(page, a).click();
        await expectSelected(page, a);
        await sessionCard(page, b).click({ modifiers: ['Meta'] });
        await expectSelected(page, b);
        expect((await windowSessions(page)).openSessionIds).toEqual([b]);
        await expect(page.getByRole('tablist', { name: 'Open Sessions' })).toHaveCount(0);

        // (2) Cmd+1 to Cmd+9 follow the Pinned group's order; 9 is always the last Pinned Session.
        await pageRequest(page, 'session.setPinned', { sessionId: c, pinned: true });
        await pageRequest(page, 'session.setPinned', { sessionId: a, pinned: true });
        await expect(page.locator('[data-pinned-group] .session-card')).toHaveCount(2);
        const pinned = await page
            .locator('[data-pinned-group] .session-card')
            .evaluateAll((cards) =>
                cards.map((card) => (card as HTMLElement).dataset.sessionId ?? ''),
            );
        expect(new Set(pinned)).toEqual(new Set([a, c]));
        await page.keyboard.press('Meta+1');
        await expectSelected(page, pinned[0]);
        await page.keyboard.press('Meta+2');
        await expectSelected(page, pinned[1]);
        await page.keyboard.press('Meta+1');
        await page.keyboard.press('Meta+9');
        await expectSelected(page, pinned[1]);
        expect((await windowSessions(page)).openSessionIds).toEqual([pinned[1]]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Open in New Window moves a Session into its own window, and the window comes back after a restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-open-in-window-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        await createShellSession(page);
        const a = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const b = await selectedSessionId(page);
        await sessionCard(page, a).click();
        await expectSelected(page, a);

        // (1) The Session this window shows has no entry: moving it would leave the window empty.
        expect(await rowMenuLabels(page, app, a)).not.toContain(OPEN_IN_NEW_WINDOW);
        await dismissContextMenu(app);

        // (2) Any other row opens in a new window that owns it; the source window keeps what it shows.
        expect(await rowMenuLabels(page, app, b)).toContain(OPEN_IN_NEW_WINDOW);
        await chooseContextMenuItem(app, OPEN_IN_NEW_WINDOW);
        await expect.poll(() => app.windows().length).toBe(2);
        const opened = app.windows().find((window) => window !== page)!;
        await expect.poll(async () => (await windowSessions(opened)).openSessionIds).toEqual([b]);
        await expect.poll(() => selectedSessionId(opened)).toBe(b);
        expect((await windowSessions(page)).openSessionIds).toEqual([a]);

        // (3) From the source window the moved row has no entry either, and selecting it activates its owner instead.
        expect(await rowMenuLabels(page, app, b)).not.toContain(OPEN_IN_NEW_WINDOW);
        await dismissContextMenu(app);
        await sessionCard(page, b).click();
        await expect.poll(() => selectedSessionId(page)).toBe(a);
        expect((await windowSessions(page)).openSessionIds).toEqual([a]);

        // (4) A real quit keeps the new window stored; the next launch reopens it with the same Session.
        await app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect.poll(() => running.app.windows().length).toBe(2);
        const restored = running.app.windows().find((window) => window !== running.page)!;
        await expect.poll(async () => (await windowSessions(restored)).openSessionIds).toEqual([b]);
        expect((await windowSessions(running.page)).openSessionIds).not.toContain(b);

        // (5) Closing that window releases the Session without archiving it, so this window can show it again.
        await restored.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await sessionCard(running.page, b).click();
        await expectSelected(running.page, b);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
