import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { resolveRuntimeExecutable } from '../src/runtime/executables.ts';
import { execFileAsync } from '../src/shared/node/exec.ts';
import { realCodexSmokeArguments } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const isRealAgentEnabled = process.env.CAXRI_REAL_AGENT_E2E === '1';
const expectedReply = 'CAXRI_REAL_AGENT_OK';
const prompt = `Read README.md and reply exactly ${expectedReply}. Do not modify any files.`;

test.use({ screenshot: 'off', trace: 'off' });
test.skip(
    !isRealAgentEnabled,
    'Set CAXRI_REAL_AGENT_E2E=1 to authorize the isolated real Codex smoke test.',
);

test('an explicitly authorized real Codex handles one natural read-only prompt', async () => {
    test.setTimeout(90_000);
    if (/\p{Cc}/u.test(prompt) || prompt.length > 200)
        throw new Error(
            'Real Agent smoke prompts must be short natural text without control bytes',
        );

    const executable = await resolveRuntimeExecutable('codex');
    if (!executable) throw new Error('Real Agent E2E requires the Codex CLI on the login PATH');
    try {
        await execFileAsync(executable, ['login', 'status'], { timeout: 10_000 });
    } catch {
        throw new Error('Real Agent E2E requires an authenticated Codex CLI');
    }

    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-real-agent-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), '# Real Agent smoke fixture\n', 'utf8');

    const running = await launchCaxri({
        agentMode: { mode: 'real', provider: 'codex' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    codex: {
                        hooks: { enabled: false },
                        launch: {
                            executable: 'codex',
                            args: realCodexSmokeArguments(prompt),
                        },
                    },
                },
            }),
        });
        await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText(expectedReply, {
            timeout: 60_000,
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
