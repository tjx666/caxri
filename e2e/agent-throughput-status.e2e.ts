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
        message: { id, model: 'claude-fixture', usage: { output_tokens: outputTokens } },
    });

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the status bar shows the active Agent Terminal output speed from its transcript', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-throughput-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: claudeFixtureSource() } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
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
        // Nothing is measured before the first response, so the chip holds no slot.
        await writeFile(transcriptPath, prompt(0));
        await expect(running.page.locator('.statusbar')).toBeVisible();
        await expect(chip).toHaveCount(0);

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
        await testInfo.attach('agent-throughput-chip', {
            body: await running.page.locator('.statusbar').screenshot(),
            contentType: 'image/png',
        });

        await chip.hover();
        const tooltip = running.page.locator('.tooltip-popup');
        await expect(tooltip).toContainText('Claude Code output speed');
        await expect(tooltip).toContainText('90 tok/s over the last 3 responses');
        await expect(tooltip).toContainText('300 tokens in 2.0 s · 150 tok/s');
        await expect(tooltip).toContainText('Includes waiting for the first token');
        await testInfo.attach('agent-throughput-tooltip', {
            body: await running.page.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { force: true, recursive: true });
    }
});
