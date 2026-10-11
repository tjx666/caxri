import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
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

        // This Mac adds the conversation run outside Caxri, grouped outside every Project.
        await usage.getByRole('button', { name: 'This Mac' }).click();
        await expect(usage.getByText('Outside Caxri', { exact: true }).first()).toBeVisible();
        await expect(usage.getByText('Across 0 Sessions + 1 outside')).toBeVisible();
        await usage.getByRole('button', { name: 'Caxri' }).click();
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
