import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';
import { sampleIdleResources } from './support/process-resources.ts';

/**
 * Time left for startup work (file tree, Git status, Agent probes) to finish before a sample starts.
 */
const SETTLE_MS = 20_000;

/**
 * One sample window. A minute averages out periodic pollers that tick every few seconds.
 */
const SAMPLE_MS = 60_000;

/**
 * Diagnostic benchmark: what a visible window costs in CPU and memory while nobody touches it, first on a Terminal
 * Session and then on an Agent Chat. It asserts no budget, since idle numbers depend on the machine and display, so
 * compare receipts from the same machine. See docs/idle-resources.md.
 */
test('benchmark: idle CPU and memory of a visible window', async () => {
    test.skip(process.env.CAXRI_IDLE_BENCHMARK !== '1', 'Set CAXRI_IDLE_BENCHMARK=1 to measure.');
    test.setTimeout(8 * 60_000);
    const projectRoot = process.env.CAXRI_BENCHMARK_PROJECT_ROOT;
    if (!projectRoot)
        throw new Error('Set CAXRI_BENCHMARK_PROJECT_ROOT to a representative repository.');
    const created = await mkdtemp(join(tmpdir(), 'caxri-idle-benchmark-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const running = await launchCaxri({
        agentMode: await fakeCodexChatAgentMode(directory, userData),
        userDataDir: userData,
        testRootPath: projectRoot,
        // A hidden or GPU-less window paints differently, which would hide exactly the idle cost this measures.
        windowMode: 'visible',
        gpuMode: 'enabled',
    });
    try {
        const { app, page } = running;
        const serverPid = (await pageRequest<{ pid: number }>(page, 'host.status')).pid;
        const sample = async () => {
            await page.waitForTimeout(SETTLE_MS);
            const resources = await sampleIdleResources(app, serverPid, SAMPLE_MS);
            return {
                ...resources,
                visibility: await page.evaluate(() => document.visibilityState),
            };
        };
        await createProjectSession(page, 'shell');
        const terminal = await sample();
        await openAgentChat(page, 'Codex Chat');
        const chat = await sample();
        const receipt = {
            kind: 'idle-resources',
            sampleMs: SAMPLE_MS,
            scenarios: { terminal, chat },
        };
        const receiptDirectory = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
            join(receiptDirectory, 'idle-resources.json'),
            `${JSON.stringify(receipt, null, 2)}\n`,
        );
        process.stdout.write(`CAXRI_IDLE_BENCHMARK ${JSON.stringify(receipt)}\n`);
    } finally {
        await closeAppQuietly(running.app);
    }
});
