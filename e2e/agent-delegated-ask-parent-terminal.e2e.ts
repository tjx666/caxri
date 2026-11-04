import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentDelegationReceipt, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';
import type { StoredQuestionRead } from './support/server-database/delegation-question.ts';

/**
 * A Terminal (PTY) child, not a Chat, must reach the same `ask` path: the question is asked through the real Caxri CLI
 * inside the PTY, which proves the path does not depend on a Chat-only API. Takeover of a started Terminal child is
 * covered per surface by the Server integration tests; this child is still in its startup, where typed input answers a
 * startup prompt instead.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Terminal child asks the Agent that delegated it and its question is stored open', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegated-ask-pty-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'project');
    const askPath = join(directory, 'ask.json');
    const cliPath = join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
// 合成终端子 Agent：被委派启动时通过继承的受管凭据运行真实 CLI 提问，并保存回执。
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('2.1.266 (Claude Code)'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('\u001b[c');
if (process.argv.includes('--session-id')) {
  const asked = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, 'agent', 'delegate', 'ask', '--text', 'Synthetic terminal question?', '--request-id', 'e2e-pty-ask', '--json'], { encoding: 'utf8', env: process.env, timeout: 45000 });
  fs.writeFileSync(${JSON.stringify(askPath)}, JSON.stringify({ status: asked.status, stdout: asked.stdout, stderr: asked.stderr }));
}
process.stdout.write('Synthetic terminal child ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        const { page } = running;
        const sessionId = await createProjectSession(page, 'shell');
        const projectId = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
            (session) => session.id === sessionId,
        )!.projectId;
        await pageRequest<AgentDelegationReceipt>(page, 'agent.delegation.create', {
            projectId,
            sessionId,
            provider: 'claude',
            prompt: 'Synthetic terminal task',
        });

        let result: { outcome?: string; questionId?: string } = {};
        await expect
            .poll(
                async () => {
                    try {
                        const written = JSON.parse(await readFile(askPath, 'utf8')) as {
                            status: number;
                            stdout: string;
                        };
                        result =
                            written.status === 0
                                ? (JSON.parse(written.stdout) as typeof result)
                                : {};
                        return written.status;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                        throw error;
                    }
                },
                { timeout: 60_000 },
            )
            .toBe(0);
        expect(result).toMatchObject({ outcome: 'asked' });
        const questionId = result.questionId!;
        const read = () =>
            runServerDatabase<StoredQuestionRead | null>('delegation-question', {
                action: 'read',
                userData,
                questionId,
            });
        expect(await read()).toMatchObject({ state: 'open', isEscalated: false });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
