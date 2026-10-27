import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, VISIBLE_SESSION } from './support/helpers.ts';

const CODEX_THREAD_ID = '01a1169a-d6bd-7b81-9ad9-6a6b432c3892';

/**
 * A content-free Codex rollout in the isolated E2E `CODEX_HOME`, as if run in a plain terminal outside any Project.
 */
async function writeOutsideCodexRollout(userDataDirectory: string): Promise<void> {
    const day = join(userDataDirectory, 'e2e-agents', 'codex', 'sessions', '2026', '10', '07');
    await mkdir(day, { recursive: true });
    const timestamp = new Date().toISOString();
    const records = [
        {
            timestamp,
            type: 'session_meta',
            payload: { id: CODEX_THREAD_ID, cwd: '/tmp/elsewhere' },
        },
        { timestamp, type: 'turn_context', payload: { model: 'gpt-5' } },
        {
            timestamp,
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: { total_token_usage: { input_tokens: 1_200, output_tokens: 300 } },
            },
        },
    ];
    await writeFile(
        join(day, `rollout-2026-10-07T21-43-28-${CODEX_THREAD_ID}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
}

async function runOpenUsage(page: Page): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog');
    await palette.getByPlaceholder('Search projects, sessions, and commands…').fill('open usage');
    await palette.getByText('Open Usage', { exact: true }).click();
}

test('Open Usage asks for a Project first, then opens the Usage tab and switches its scope', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-usage-e2e-'));
    const root = join(testDirectory, 'project');
    const userDataDirectory = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });
    await writeOutsideCodexRollout(userDataDirectory);
    const running = await launchCaxri({ userDataDir: userDataDirectory, testRootPath: root });
    try {
        await runOpenUsage(running.page);
        await expect(running.page.getByText('Add a Project to open Usage')).toBeVisible();

        await createProjectSession(running.page, 'shell');
        await runOpenUsage(running.page);
        const usage = running.page.locator(`${VISIBLE_SESSION} [data-usage-page]`);
        await expect(usage.getByRole('heading', { name: 'Usage' })).toBeVisible();
        // A fresh profile has no Agent conversations, so the report settles on the empty state.
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();
        await usage.getByRole('button', { name: '7D' }).click();
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();

        // This Mac adds the conversation run outside Caxri, grouped outside every Project. The empty Caxri report offers
        // the same scope switch as a button, so that is the path exercised here.
        await usage.getByRole('button', { name: 'Show This Mac', exact: true }).click();
        await expect(usage.getByRole('button', { name: 'This Mac', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(usage.getByText('Outside Caxri', { exact: true }).first()).toBeVisible();
        await expect(usage.getByText('Across 0 Sessions + 1 outside')).toBeVisible();
        await usage.getByRole('button', { name: 'Caxri', exact: true }).click();
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * The Usage page's date format, `Oct 7, 2026`.
 */
function usageDate(date: Date): string {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

test('Usage narrows the report to today or to a custom span picked in its calendar', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-usage-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'shell');
        await runOpenUsage(running.page);
        const usage = running.page.locator(`${VISIBLE_SESSION} [data-usage-page]`);
        const today = new Date();
        const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        await usage.getByRole('button', { name: 'Today', exact: true }).click();
        await expect(usage.getByText(`${usageDate(today)} · Costs are API`)).toBeVisible();

        await usage.getByRole('button', { name: 'Custom', exact: true }).click();
        const calendar = running.page.getByRole('group', { name: 'Custom date range' });
        // Picked end first: the second click still completes the span in date order.
        await calendar.getByRole('button', { name: String(today.getDate()), exact: true }).click();
        await calendar.getByRole('button', { name: '1', exact: true }).click();
        await calendar.getByRole('button', { name: 'Apply' }).click();
        await expect(calendar).toHaveCount(0);
        const span =
            today.getDate() === 1
                ? usageDate(today)
                : `${usageDate(firstOfMonth)} to ${usageDate(today)}`;
        await expect(usage.getByText(`${span} · Costs are API`)).toBeVisible();
        await expect(usage.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

async function expectNoScrollFade(scroller: Locator): Promise<void> {
    await expect(scroller).not.toHaveAttribute('data-scroll-fade-start');
    await expect(scroller).not.toHaveAttribute('data-scroll-fade-end');
}

/**
 * A classic scrollbar takes layout space below the content; a macOS overlay scrollbar, hidden at rest, takes none.
 */
async function expectVisibleRail(scroller: Locator): Promise<void> {
    await expect
        .poll(() =>
            scroller.evaluate(
                (element) => (element as HTMLElement).offsetHeight - element.clientHeight,
            ),
        )
        .toBeGreaterThan(0);
}

/**
 * Issue #1958: macOS overlay scrollbars stay hidden at rest, so a narrow pane cut off the right of the Models table and
 * the older weeks of the Activity chart with no sign that more was there. Each sideways scroller now fades the edge
 * that hides content, and only that edge, and keeps a scrollbar rail visible at rest.
 */
test('Usage fades the hidden edge of its tables and Activity chart in a narrow pane', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-usage-e2e-'));
    const root = join(testDirectory, 'project');
    const userDataDirectory = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });
    await writeOutsideCodexRollout(userDataDirectory);
    const running = await launchCaxri({ userDataDir: userDataDirectory, testRootPath: root });
    try {
        await createProjectSession(running.page, 'shell');
        await runOpenUsage(running.page);
        const usage = running.page.locator(`${VISIBLE_SESSION} [data-usage-page]`);
        await usage.getByRole('button', { name: 'Show This Mac', exact: true }).click();
        await expect(usage.getByText('Outside Caxri', { exact: true }).first()).toBeVisible();

        const models = usage
            .getByRole('region', { name: 'Models', exact: true })
            .locator('[data-horizontal-scroll]');
        const activity = usage.locator('[data-horizontal-scroll][role="img"]');
        await expect(models.locator('table')).toBeVisible();

        // Wide: nothing overflows, so neither edge is cued.
        await expectNoScrollFade(models);
        await expectNoScrollFade(activity);

        // The issue's ~425px editor group, narrower than the window's minimum width allows the whole pane to be.
        await usage.evaluate((element) => {
            (element as HTMLElement).style.width = '425px';
        });
        // The table starts at its first column, so its right edge hides the figures.
        await expect(models).toHaveAttribute('data-scroll-fade-end', 'true');
        await expect(models).not.toHaveAttribute('data-scroll-fade-start');
        // The chart stays pinned to the newest weeks, so its left edge hides the older ones.
        await expect(activity).toHaveAttribute('data-scroll-fade-start', 'true');
        await expect(activity).not.toHaveAttribute('data-scroll-fade-end');
        // The rail is a classic scrollbar that takes layout space, so it shows at rest even where macOS would use a
        // hidden overlay scrollbar.
        await expectVisibleRail(models);
        await expectVisibleRail(activity);

        // Scrolled to its end, the table's cue moves to the edge that now hides content.
        await models.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
        });
        await expect(models).toHaveAttribute('data-scroll-fade-start', 'true');
        await expect(models).not.toHaveAttribute('data-scroll-fade-end');

        await usage.evaluate((element) => {
            (element as HTMLElement).style.width = '';
        });
        await expect(models).not.toHaveAttribute('data-scroll-fade-start');
        await expect(activity).not.toHaveAttribute('data-scroll-fade-start');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
