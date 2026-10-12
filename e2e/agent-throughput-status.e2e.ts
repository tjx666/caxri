import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

const AGENT_SESSION_ID = 'e2e-throughput-project';
const BASE = Date.now() - 60_000;
const USAGE_LABEL = '121k · $0.37';

function claudeFixtureSource(): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-claude 1.0.0\n');
  process.exit(0);
}
const now = Date.now();
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, 'current.json'), JSON.stringify({
  cwd: process.cwd(),
  name: 'Throughput Fixture',
  sessionId: 'e2e-throughput-' + path.basename(process.cwd()),
  startedAt: now,
  status: 'busy',
  updatedAt: now,
}));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake claude ready\r\n');
`;
}

function line(seconds: number, entry: Record<string, unknown>): string {
    return `${JSON.stringify({ timestamp: new Date(BASE + seconds * 1_000).toISOString(), ...entry })}\n`;
}

const prompt = (seconds: number) =>
    line(seconds, { type: 'user', message: { role: 'user', content: 'Run the build' } });
const toolResult = (seconds: number) =>
    line(seconds, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool' }] },
    });
const response = (seconds: number, id: string, outputTokens: number) =>
    line(seconds, {
        type: 'assistant',
        message: {
            id,
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 40_000, output_tokens: outputTokens },
        },
    });

/**
 * Long enough to overflow the status-bar card, so the card must truncate it while keeping the incident's phase whole.
 */
const INCIDENT_NAME =
    'Slow Claude Code responses and elevated error rates for some users on long-running sessions';

/**
 * A synthetic Claude status page in Statuspage's summary shape: Claude Code is degraded by an open incident, and a
 * component the Agent does not use is down to prove it is left out.
 */
const claudeStatusPage = {
    page: { name: 'Claude', url: 'https://status.claude.com' },
    components: [
        { id: 'web', name: 'claude.ai', status: 'major_outage' },
        { id: 'api', name: 'Claude API (api.anthropic.com)', status: 'operational' },
        { id: 'code', name: 'Claude Code', status: 'degraded_performance' },
    ],
    incidents: [
        {
            id: 'fixture-incident',
            name: INCIDENT_NAME,
            status: 'identified',
            impact: 'minor',
            updated_at: new Date(BASE).toISOString(),
            components: [{ id: 'code' }],
            incident_updates: [
                { body: 'A fix is being deployed.', updated_at: new Date(BASE).toISOString() },
            ],
        },
    ],
};

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the status bar shows the active Agent Terminal output speed and usage from its transcript', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-throughput-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const statusPages = join(testDirectory, 'status-pages');
    await mkdir(statusPages);
    await writeFile(join(statusPages, 'status.claude.com.json'), JSON.stringify(claudeStatusPage));
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: claudeFixtureSource() } },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_PROVIDER_STATUS_DIR: statusPages },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<{
                    terminals: Array<{ agentSessionId?: string; sessionId: string }>;
                }>(running.page, 'app.bootstrap');
                return bootstrap.terminals.find((candidate) => candidate.sessionId === sessionId)
                    ?.agentSessionId;
            })
            .toBe(AGENT_SESSION_ID);
        const bootstrap = await pageRequest<{
            terminals: Array<{ cwd: string; sessionId: string }>;
        }>(running.page, 'app.bootstrap');
        const terminal = bootstrap.terminals.find((candidate) => candidate.sessionId === sessionId);
        const claudeConfigDirectory = agentMode.environment.CLAUDE_CONFIG_DIR;
        if (!terminal || !claudeConfigDirectory)
            throw new Error('Claude Terminal fixture was not created');
        const transcriptPath = join(
            claudeConfigDirectory,
            'projects',
            terminal.cwd.replaceAll(/[^a-z0-9]/gi, '-'),
            `${AGENT_SESSION_ID}.jsonl`,
        );
        await mkdir(dirname(transcriptPath), { recursive: true });

        const chip = running.page.locator('.statusbar-agent-throughput');
        // Nothing is measured before the first response, but Claude Code is degraded on the fixture page, so the chip
        // already holds a muted placeholder whose glyph carries the warning dot.
        await writeFile(transcriptPath, prompt(0));
        await expect(running.page.locator('.statusbar')).toBeVisible();
        await expect(chip).toHaveText('—');
        await expect(chip.locator('[data-provider-status="warning"]')).toHaveCount(1);
        await expect(chip).toHaveAccessibleName(
            /output speed: not measured yet; API status: Degraded/,
        );

        // 200 tokens in 4 s, then 400 tokens in 4 s: 600 tokens over 8 s.
        await appendFile(
            transcriptPath,
            response(2, 'msg-1', 200) +
                response(4, 'msg-1', 200) +
                toolResult(5) +
                response(9, 'msg-2', 400),
        );
        await expect(chip).toHaveText('75 tok/s');

        // A further 300 tokens in 2 s moves the token-weighted rate to 900 tokens over 10 s.
        await appendFile(transcriptPath, toolResult(10) + response(12, 'msg-3', 300));
        await expect(chip).toHaveText('90 tok/s');
        // Claude Code is degraded on the fixture page: the glyph carries a warning dot, and the name says so in words.
        await expect(chip.locator('[data-provider-status="warning"]')).toHaveCount(1);
        await expect(chip).toHaveAccessibleName(/, API status: Degraded performance$/);
        await testInfo.attach('agent-throughput-chip', {
            body: await running.page.locator('.statusbar').screenshot(),
            contentType: 'image/png',
        });

        await chip.hover();
        const tooltip = running.page.locator('.tooltip-popup');
        await expect(tooltip).toContainText('Claude output speed');
        await expect(tooltip).toContainText('90 tok/s');
        await expect(tooltip).toContainText('Average of the last 3 responses');
        await expect(tooltip).toContainText('300 tokens in 2.0s · 150 tok/s');
        await expect(tooltip).toContainText('Includes waiting for the first token');
        await expect(tooltip).toContainText('API status');
        await expect(tooltip).toContainText('Degraded performance: Claude Code');
        await expect(tooltip).toContainText(`${INCIDENT_NAME} (Identified)`);
        // The long incident name truncates, and its phase stays whole beside the ellipsis.
        const incidentName = tooltip.getByText(INCIDENT_NAME, { exact: true });
        await expect
            .poll(() => incidentName.evaluate((name) => name.scrollWidth > name.clientWidth))
            .toBe(true);
        const phase = tooltip.getByText('(Identified)', { exact: true });
        await expect(phase).toBeVisible();
        await expect
            .poll(() => phase.evaluate((element) => element.scrollWidth <= element.clientWidth))
            .toBe(true);
        const [phaseBox, tooltipBox] = await Promise.all([
            phase.boundingBox(),
            tooltip.boundingBox(),
        ]);
        expect(phaseBox!.x + phaseBox!.width).toBeLessThanOrEqual(
            tooltipBox!.x + tooltipBox!.width,
        );
        await expect(tooltip).not.toContainText('claude.ai');
        await testInfo.attach('agent-throughput-tooltip', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });

        // The same transcript prices at list price: 120k input and 900 output tokens of Claude Sonnet 4.5.
        const usageChip = running.page.locator('.statusbar-agent-usage');
        await expect(usageChip).toHaveText(USAGE_LABEL);
        await usageChip.hover();
        // The output speed card may still be fading out beside the usage card.
        const usageTooltip = running.page.locator('.tooltip-popup[data-open]');
        await expect(usageTooltip).toContainText('Claude conversation usage');
        await expect(usageTooltip).toContainText('121k: 120k input, 900 output');
        await expect(usageTooltip).not.toContainText('cache read');
        await expect(usageTooltip).toContainText('claude-sonnet-4-5');
        await testInfo.attach('agent-usage-tooltip', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });

        await chip.click();
        const statusPage = running.page.locator('[data-agent-status-page]');
        await expect(statusPage).toBeVisible();
        await expect(statusPage.getByRole('heading', { name: 'Claude Status' })).toBeVisible();
        await expect(statusPage).toContainText('300 tokens in 2.0s · 150 tok/s');
        await expect(
            statusPage.getByRole('list', { name: 'Output speed of the last 3 responses' }),
        ).toBeVisible();
        await expect(statusPage).toContainText('Claude API (api.anthropic.com)');
        await expect(statusPage).toContainText('Identified · Degraded performance · Claude Code');
        await expect(statusPage).toContainText('A fix is being deployed.');
        await expect(statusPage.getByRole('button', { name: 'Open status page' })).toBeVisible();
        await testInfo.attach('agent-status-page', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { force: true, recursive: true });
    }
});
