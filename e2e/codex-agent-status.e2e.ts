import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const execFileAsync = promisify(execFile);
const THREAD_ID = '019a0000-0000-7000-8000-000000000077';
const DAY_MS = 86_400_000;

/**
 * A fake Codex that holds its rollout open (which binds the Terminal to the thread) after writing three measured
 * responses: one before Codex recorded any tier, one after `/fast` turned Fast mode on, and one after a switch to
 * another model at the standard tier. A token count carries a weekly limit 8% used.
 */
function codexFixtureSource(): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.153.4\n');
  process.exit(0);
}
// The transcript locator finds a rollout in the local day folder of the thread id's UUIDv7 timestamp.
const created = new Date(Number.parseInt('${THREAD_ID}'.replace('-', '').slice(0, 12), 16));
const pad = (value) => String(value).padStart(2, '0');
const directory = path.join(process.env.CODEX_HOME, 'sessions', String(created.getFullYear()),
  pad(created.getMonth() + 1), pad(created.getDate()));
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'rollout-2026-01-01T00-00-00-${THREAD_ID}.jsonl');
const base = Date.now() - 120000;
const line = (seconds, type, payload) =>
  JSON.stringify({ timestamp: new Date(base + seconds * 1000).toISOString(), type, payload }) + '\n';
const settings = (model, tier) =>
  line(0, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model, service_tier: tier } });
const turn = (start, model, seconds, id, tokens) =>
  line(start, 'turn_context', { model }) +
  line(start, 'event_msg', { type: 'task_started' }) +
  line(start + seconds, 'response_item', { type: 'reasoning' }) +
  line(start + seconds, 'token_usage_record', { response_id: id, usage: { output_tokens: tokens } });
fs.writeFileSync(file,
  turn(0, 'gpt-a', 4, 'resp-1', 400) +
  settings('gpt-a', 'priority') +
  turn(10, 'gpt-a', 2, 'resp-2', 600) +
  settings('gpt-b', 'default') +
  turn(20, 'gpt-b', 5, 'resp-3', 500) +
  line(26, 'event_msg', { type: 'token_count',
    info: { total_token_usage: { input_tokens: 12000, output_tokens: 1500 } },
    rate_limits: {
    primary: { used_percent: 8, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 },
  } }));
const fd = fs.openSync(file, 'a');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.on('exit', () => fs.closeSync(fd));
process.stdout.write('Fake Codex ready\r\n');
`;
}

/**
 * OpenAI's incident.io feed: the CLI component is down to prove only Codex API is listed, and the history feed holds
 * one Codex API outage two days ago.
 */
function openAiStatusPages(now: number) {
    return {
        summary: {
            summary: {
                name: 'OpenAI',
                public_url: 'https://status.openai.com/',
                structure: {
                    items: [
                        {
                            group: {
                                name: 'Codex',
                                components: [
                                    { component_id: 'cx-web', name: 'Codex Web' },
                                    { component_id: 'cx-api', name: 'Codex API' },
                                    { component_id: 'cx-cli', name: 'CLI' },
                                ],
                            },
                        },
                    ],
                },
                affected_components: [{ component_id: 'cx-cli', status: 'full_outage' }],
                ongoing_incidents: [],
            },
        },
        history: {
            component_impacts: [
                {
                    component_id: 'cx-api',
                    start_at: new Date(now - 2 * DAY_MS).toISOString(),
                    end_at: new Date(now - 2 * DAY_MS + 3_600_000).toISOString(),
                    status: 'partial_outage',
                },
            ],
            // The live feed also lists a per-group figure keyed by group id, without a `component_id`.
            component_uptimes: [
                { component_id: 'cx-api', uptime: '99.95' },
                { status_page_component_group_id: 'cx-group', uptime: '99.90' },
            ],
        },
    };
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the Codex Agent status page shows Codex API uptime, speed by model and mode, and the limit left', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-status-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const state = join(userData, 'e2e-agents', 'codex');
    const statusPages = join(testDirectory, 'status-pages');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(state, { recursive: true }),
        mkdir(statusPages),
    ]);
    await execFileAsync('sqlite3', [
        join(state, 'state_9.sqlite'),
        `CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER);
         INSERT INTO threads VALUES ('${THREAD_ID}', '/previous-worktree', 'First prompt',
            'Codex status fixture', 1, 1, 0, 0);`,
    ]);
    const pages = openAiStatusPages(Date.now());
    await writeFile(join(statusPages, 'status.openai.com.json'), JSON.stringify(pages.summary));
    await writeFile(
        join(statusPages, 'status.openai.com.component_impacts.json'),
        JSON.stringify(pages.history),
    );
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { executableSource: codexFixtureSource() } },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_PROVIDER_STATUS_DIR: statusPages },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'codex');
        await expect
            .poll(
                async () =>
                    (
                        await pageRequest<{ terminals: Array<{ agentSessionId?: string }> }>(
                            running.page,
                            'app.bootstrap',
                        )
                    ).terminals[0]?.agentSessionId,
                { timeout: 20_000 },
            )
            .toBe(THREAD_ID);
        const usageChip = running.page.locator('.statusbar-agent-usage');
        await expect(usageChip).toContainText('7d 92% left');

        const chip = running.page.locator('.statusbar-agent-throughput');
        // 1,500 tokens over 11 s.
        await expect(chip).toHaveText('136 tok/s');
        await chip.click();
        const statusPage = running.page.locator('[data-agent-status-page]');
        await expect(statusPage.getByRole('heading', { name: 'Codex Status' })).toBeVisible();

        const byModel = statusPage.getByRole('region', { name: 'By model' });
        const rows = byModel.getByRole('row');
        await expect(rows).toHaveCount(4);
        await expect(rows.nth(1)).toHaveText(/gpt-a.*Mode not recorded.*100\s*tok\/s/);
        await expect(byModel).toContainText(/gpt-a\s*Fast\s*300\s*tok\/s/);
        await expect(byModel).toContainText(/gpt-b\s*Standard\s*100\s*tok\/s/);
        await expect(byModel).toContainText('Codex writes it only after the mode changes');

        const provider = statusPage.getByRole('region', { name: 'OpenAI API status' });
        await expect(provider).toContainText('Codex API');
        await expect(provider).not.toContainText('Codex Web');
        await expect(provider).not.toContainText('CLI');
        await expect(provider).toContainText('99.95% uptime');
        // One focus stop for the whole strip: the arrow keys step through the days and announce each.
        const chart = provider.getByRole('img', {
            name: 'Codex API status for each of the last 90 days',
        });
        const bars = chart.locator(':scope > div');
        await expect(bars).toHaveCount(90);
        const announced = provider.locator('[aria-live="polite"]');
        await chart.focus();
        await chart.press('End');
        await expect(announced).toHaveText(/Operational$/);
        await chart.press('ArrowLeft');
        await chart.press('ArrowLeft');
        await expect(announced).toHaveText(/Partial outage$/);
        await bars.nth(87).hover();
        await expect(running.page.locator('.tooltip-popup')).toContainText('Partial outage');
        await testInfo.attach('codex-agent-status-page', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { force: true, recursive: true });
    }
});
