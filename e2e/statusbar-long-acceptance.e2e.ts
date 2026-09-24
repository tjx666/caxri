import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const REPORT_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const AGENT_SESSION_ID = 'e2e-long-acceptance';

function fakeClaudeSource(): string {
    return String.raw`#!${process.execPath}
// Create a synthetic long transcript before announcing the Agent session; no host Agent or report service is used.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-claude 1.0.0\n');
  process.exit(0);
}
const cwd = process.cwd();
const agentSessionId = ${JSON.stringify(AGENT_SESSION_ID)};
const config = process.env.CLAUDE_CONFIG_DIR;
const project = path.join(config, 'projects', cwd.replaceAll(/[^a-z0-9]/gi, '-'));
const filler = JSON.stringify({ type: 'event_msg', data: 'x'.repeat(1024 * 1024) }) + '\n';
const message = JSON.stringify({
  type: 'assistant',
  cwd,
  message: { content: [{ type: 'text', text: 'Acceptance: https://app.lobehub.com/acceptance/${REPORT_ID}?r=7' }] },
}) + '\n';
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, agentSessionId + '.jsonl'), filler.repeat(17) + message);
const sessions = path.join(config, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const now = Date.now();
fs.writeFileSync(path.join(sessions, 'current.json'), JSON.stringify({
  cwd, name: 'Long acceptance fixture', sessionId: agentSessionId,
  startedAt: now, status: 'busy', updatedAt: now,
}));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake Claude ready\r\n');
`;
}

test('shows a report at the tail of a long Agent conversation on the first status refresh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-long-acceptance-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const bin = join(directory, 'bin');
    await mkdir(root, { recursive: true });
    await mkdir(bin, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await writeFile(join(bin, 'lh'), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, 'lh'), 0o755);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: fakeClaudeSource() } },
    });
    const running = await launchCaxri({
        agentMode,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
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
                return bootstrap.terminals.find((terminal) => terminal.sessionId === sessionId)
                    ?.agentSessionId;
            })
            .toBe(AGENT_SESSION_ID);
        await running.page.reload();

        const acceptance = running.page.getByRole('link', { name: /Open acceptance report/ });
        await expect(acceptance).toBeVisible({ timeout: 15_000 });
        await expect(acceptance).toHaveAttribute(
            'href',
            `https://app.lobehub.com/acceptance/${REPORT_ID}?turn=7`,
        );
        await expect(acceptance).toHaveAttribute('aria-label', /Round 7/);
        await running.page.screenshot({ path: 'test-results/statusbar-long-acceptance.png' });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
