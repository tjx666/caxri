import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

interface SessionTitleMetrics {
    distance: number;
    now: number;
    textOverflow: string;
    transform: string;
    transformX: number;
    viewportWidth: number;
}

async function titleMetrics(title: Locator): Promise<SessionTitleMetrics> {
    return title.evaluate((element) => {
        const text = element.querySelector('span');
        if (!text) throw new Error('Session title text span is missing');
        const style = getComputedStyle(text);
        const transform = style.transform;
        const transformX = transform === 'none' ? 0 : new DOMMatrix(transform).e;
        return {
            distance: Math.max(0, text.scrollWidth - element.clientWidth),
            now: performance.now(),
            textOverflow: getComputedStyle(element).textOverflow,
            transform,
            transformX,
            viewportWidth: element.getBoundingClientRect().width,
        };
    });
}

async function expectStableTransform(page: Page, title: Locator, duration: number): Promise<void> {
    const startedAt = await page.evaluate(() => performance.now());
    await expect
        .poll(
            async () => {
                const metrics = await titleMetrics(title);
                return metrics.now - startedAt >= duration ? metrics.transformX : undefined;
            },
            { intervals: [100, 100, 200, 300, 400], timeout: duration + 1_200 },
        )
        .toBe(0);
}

async function waitForTitleMotion(title: Locator): Promise<void> {
    await expect
        .poll(async () => (await titleMetrics(title)).transformX, {
            intervals: [100, 100, 200, 300],
            timeout: 2_500,
        })
        .toBeLessThan(-1);
}

async function resizePrimarySidebar(page: Page, delta: number): Promise<void> {
    const sidebar = page.locator('.session-primary-sidebar');
    const divider = page.getByRole('separator', { name: 'Resize Primary Side Bar' });
    const before = (await sidebar.boundingBox())?.width;
    const dividerBox = await divider.boundingBox();
    if (before === undefined || !dividerBox)
        throw new Error('Primary sidebar divider is not measurable');
    const x = dividerBox.x + dividerBox.width / 2;
    const y = dividerBox.y + dividerBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
    await expect
        .poll(async () => (await sidebar.boundingBox())?.width)
        .toBeGreaterThan(before + delta * 0.7);
}

test('long Session titles scroll at a readable speed and reset across pointer and keyboard focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-title-scroll-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        const longTitle = 'Investigate this very long session title while browsing';
        await pageRequest(running.page, 'session.rename', {
            displayTitle: longTitle,
            sessionId,
        });

        const card = sessionCard(running.page, sessionId);
        const title = card.locator('.session-title');
        await expect(title).toContainText(longTitle);
        await expect.poll(async () => (await titleMetrics(title)).distance).toBeGreaterThan(12);
        expect((await titleMetrics(title)).transformX).toBe(0);

        await title.hover();
        const hoverStartedAt = await running.page.evaluate(() => performance.now());
        await expect
            .poll(
                async () => {
                    const metrics = await titleMetrics(title);
                    return metrics.now - hoverStartedAt >= 500 ? metrics.transformX : undefined;
                },
                { intervals: [50], timeout: 700 },
            )
            .toBe(0);

        let previous: SessionTitleMetrics | undefined;
        let sampledSpeed: number | undefined;
        await expect
            .poll(
                async () => {
                    const current = await titleMetrics(title);
                    if (
                        previous &&
                        current.transformX < -1 &&
                        current.now - previous.now >= 150 &&
                        current.transformX > -current.distance + 2
                    ) {
                        sampledSpeed =
                            ((previous.transformX - current.transformX) /
                                (current.now - previous.now)) *
                            1_000;
                        return sampledSpeed;
                    }
                    if (current.transformX < -1) previous = current;
                    return NaN;
                },
                { intervals: [100, 100, 200, 300], timeout: 3_000 },
            )
            .toBeGreaterThan(26);
        expect(sampledSpeed).toBeLessThan(46);

        const distance = (await titleMetrics(title)).distance;
        let endSample: SessionTitleMetrics | undefined;
        await expect
            .poll(
                async () => {
                    const current = await titleMetrics(title);
                    if (current.transformX <= -distance + 1) {
                        endSample ??= current;
                        return true;
                    }
                    return false;
                },
                {
                    intervals: [100, 200, 300, 500],
                    timeout: Math.min(20_000, Math.ceil((distance / 35) * 1_000 + 4_000)),
                },
            )
            .toBe(true);
        if (!endSample) throw new Error('Session title did not reach its scroll end');
        const endGeometry = await title.evaluate((element) => {
            const text = element.querySelector('span');
            if (!text) throw new Error('Session title text span is missing at scroll end');
            const viewportBounds = element.getBoundingClientRect();
            const textBounds = text.getBoundingClientRect();
            return {
                clientWidth: text.clientWidth,
                rightGap: Math.abs(textBounds.right - viewportBounds.right),
                scrollWidth: text.scrollWidth,
            };
        });
        expect(endGeometry.rightGap).toBeLessThanOrEqual(2);
        expect(Math.abs(endGeometry.clientWidth - endGeometry.scrollWidth)).toBeLessThanOrEqual(2);
        /**
         * The title must come to rest at its end and stay there. The target cannot be a transform sampled earlier: the
         * poll above accepts the last pixel of travel (`<= -distance + 1`), so its sample can be a frame short of where
         * the animation rests, and waiting for that value again never succeeds. Wait for the transform to stop changing
         * instead, then assert where it stopped, the same guarantee, without assuming which frame was seen.
         */
        let stableSince: number | undefined;
        let stableAt: number | undefined;
        await expect
            .poll(
                async () => {
                    const current = await titleMetrics(title);
                    const rounded = Math.round(current.transformX);
                    if (rounded !== stableAt) {
                        stableAt = rounded;
                        stableSince = current.now;
                        return NaN;
                    }
                    return current.now - stableSince! >= 300 ? rounded : NaN;
                },
                { intervals: [100, 100, 200, 300], timeout: 2_500 },
            )
            .toBeLessThanOrEqual(-Math.round(distance) + 1);

        await running.page.mouse.move(500, 300);
        await expect.poll(async () => (await titleMetrics(title)).transformX).toBe(0);
        await expect(title).toHaveCSS('text-overflow', 'clip');
        const sessionCopy = card.locator('.session-copy');
        await expect(sessionCopy).toHaveClass(/overflow-fade/);
        await expect(sessionCopy).not.toHaveAttribute('data-overflow-fade', 'off');

        // Arrow navigation supplies keyboard modality, so the Session row's :focus-visible path is exercised.
        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('ArrowDown');
        await expect(card).toBeFocused();
        await waitForTitleMotion(title);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('short titles stay still and title scroll recomputes after rename, resize, and reduced motion', async () => {
    const testDirectory = await mkdtemp(
        join(tmpdir(), 'caxri-session-title-scroll-recompute-e2e-'),
    );
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        const card = sessionCard(running.page, sessionId);
        const shortTitle = card.locator('.session-title');
        await expect(shortTitle).toHaveText('Untitled');
        await expect.poll(async () => (await titleMetrics(shortTitle)).distance).toBe(0);
        await shortTitle.hover();
        await expectStableTransform(running.page, shortTitle, 1_000);

        const firstLongTitle = 'Rename this Session while its title is already hovered';
        await pageRequest(running.page, 'session.rename', {
            displayTitle: firstLongTitle,
            sessionId,
        });
        const renamedTitle = card.locator('.session-title');
        await expect(renamedTitle).toContainText(firstLongTitle);
        await expect
            .poll(async () => (await titleMetrics(renamedTitle)).distance)
            .toBeGreaterThan(12);
        await waitForTitleMotion(renamedTitle);

        // Moving to the real divider cancels the old hover animation; the next hover must use the resized geometry.
        await resizePrimarySidebar(running.page, 80);
        await expect.poll(async () => (await titleMetrics(renamedTitle)).transformX).toBe(0);
        await renamedTitle.hover();
        await waitForTitleMotion(renamedTitle);

        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await expectStableTransform(running.page, renamedTitle, 1_000);
        await renamedTitle.hover();
        await expectStableTransform(running.page, renamedTitle, 1_000);

        await running.page.emulateMedia({ reducedMotion: 'no-preference' });
        await renamedTitle.hover();
        await waitForTitleMotion(renamedTitle);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('hovering a long Session title keeps the title from painting under Pin and Archive', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-hover-actions-clip-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        const longTitle = 'Investigate this overflowing session title under the hover actions';
        await pageRequest(running.page, 'session.rename', {
            displayTitle: longTitle,
            sessionId,
        });

        const card = sessionCard(running.page, sessionId);
        const row = running.page.locator('.session-row').filter({ has: card });
        const sessionCopy = card.locator('.session-copy');
        const rowActions = row.locator('.session-row-actions');
        await expect(card.locator('.session-title')).toContainText(longTitle);
        await expect
            .poll(async () => (await titleMetrics(card.locator('.session-title'))).distance)
            .toBeGreaterThan(12);

        const idleCopyRight = await sessionCopy.evaluate(
            (element) => element.getBoundingClientRect().right,
        );

        await card.hover();
        await expect(rowActions).toHaveCSS('opacity', '1');
        await expect(running.page.getByRole('button', { name: `Pin ${longTitle}` })).toBeVisible();
        await expect(
            running.page.getByRole('button', { name: `Archive ${longTitle}` }),
        ).toBeVisible();

        const hovered = await card.evaluate((element) => {
            const copy = element.querySelector('.session-copy');
            const actions = element.closest('.session-row')?.querySelector('.session-row-actions');
            if (!copy || !actions) throw new Error('Session title or hover actions are missing');
            const copyBox = copy.getBoundingClientRect();
            const actionsBox = actions.getBoundingClientRect();
            return {
                actionsLeft: actionsBox.left,
                copyRight: copyBox.right,
            };
        });
        expect(hovered.copyRight).toBeLessThanOrEqual(hovered.actionsLeft);
        expect(hovered.copyRight).toBeLessThan(idleCopyRight);

        await running.page.screenshot({
            path: test.info().outputPath('session-hover-actions-clip.png'),
        });

        await running.page.mouse.move(500, 300);
        await expect(rowActions).toHaveCSS('opacity', '0');
        await expect
            .poll(async () =>
                sessionCopy.evaluate((element) => element.getBoundingClientRect().right),
            )
            .toBeGreaterThan(hovered.copyRight);

        await running.page.screenshot({
            path: test.info().outputPath('session-idle-title-full-width.png'),
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
