import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
    allowE2EErrors,
    errorGateSelfTest,
    expect,
    test,
    type TestInfo,
} from './support/fixtures.ts';

import { launchCaxri, pageReply } from './support/helpers.ts';
import { runWithE2EErrorGate } from './support/error-gate.ts';

const execFileAsync = promisify(execFile);

async function observeIpcFailure(
    testInfo: TestInfo,
    name: string,
    method: string,
    params: unknown,
    expectedCode: string,
): Promise<void> {
    const testDirectory = await mkdtemp(join(tmpdir(), `caxri-error-gate-${name}-`));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect(running.page.getByLabel('Add Project')).toBeAttached();
        const reply = await pageReply(running.page, method, params);
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error.code).toBe(expectedCode);
        await expect(running.page.getByLabel('Add Project')).toBeAttached();
    } finally {
        await running.app.close().catch(() => undefined);
        await expect
            .poll(() => ({
                main: testInfo.attachments.some((attachment) =>
                    attachment.name.startsWith('caxri-main-'),
                ),
                runtime: testInfo.attachments.some((attachment) =>
                    attachment.name.startsWith('caxri-runtime-'),
                ),
            }))
            .toEqual({ main: true, runtime: true });
        await rm(testDirectory, { recursive: true, force: true });
    }
}

/** Runs the real gate directly so a negative regression can assert its exact teardown rejection. */
async function expectGateFailure(
    testInfo: TestInfo,
    expectedMessage: string,
    runTest: () => Promise<void>,
): Promise<void> {
    let bodyCompleted = false;
    let failure: unknown;
    try {
        await runWithE2EErrorGate(testInfo, async () => {
            await runTest();
            bodyCompleted = true;
        });
    } catch (error) {
        failure = error;
    }
    expect(bodyCompleted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedMessage);
}

test('issue-104-error-gate: observes a page exception while the UI remains usable', async () => {
    allowE2EErrors([
        {
            source: 'main',
            event: 'renderer.page_exception',
            code: 'PAGE_EXCEPTION',
            count: 1,
        },
        {
            source: 'main',
            event: 'renderer.console_error',
            code: 'CONSOLE_ERROR',
            count: 1,
        },
        { source: 'renderer', event: 'pageerror', code: 'PAGE_ERROR', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-error-gate-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.evaluate(() => {
            setTimeout(() => {
                throw new Error('CAXRI_EXPECTED_E2E_PAGE_EXCEPTION');
            });
        });
        const mainLogPath = join(userData, 'logs', 'main.jsonl');
        await expect
            .poll(() => readFile(mainLogPath, 'utf8'))
            .toContain('"event":"renderer.page_exception"');
        await expect(running.page.getByLabel('Add Project')).toBeAttached();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

errorGateSelfTest(
    'issue-104-error-gate: rejects an unexpected Main error after usable UI',
    async ({ browserName }, testInfo) => {
        void browserName;
        await expectGateFailure(
            testInfo,
            'Unexpected E2E errors: main/ipc.request_failed/VALIDATION x1',
            () => observeIpcFailure(testInfo, 'main-unallowed', 'e2e.invalid', {}, 'VALIDATION'),
        );
    },
);

test('issue-104-error-gate: consumes one exact Main error after usable UI', async ({
    e2eErrorGate,
}, testInfo) => {
    void e2eErrorGate;
    allowE2EErrors([{ source: 'main', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 }]);
    await observeIpcFailure(testInfo, 'main-allowed', 'e2e.invalid', {}, 'VALIDATION');
});

errorGateSelfTest(
    'issue-104-error-gate: rejects an unexpected Runtime error after usable UI',
    async ({ browserName }, testInfo) => {
        void browserName;
        await expectGateFailure(
            testInfo,
            'Unexpected E2E errors: main/ipc.request_failed/NOT_FOUND x1, runtime/ipc.request_failed/NOT_FOUND x1',
            () =>
                observeIpcFailure(
                    testInfo,
                    'runtime-unallowed',
                    'terminal.restart',
                    { terminalId: 'missing-terminal', mode: 'resume' },
                    'NOT_FOUND',
                ),
        );
    },
);

test('issue-104-error-gate: consumes exact Main and Runtime errors after usable UI', async ({
    e2eErrorGate,
}, testInfo) => {
    void e2eErrorGate;
    allowE2EErrors([
        { source: 'main', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
        { source: 'runtime', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    await observeIpcFailure(
        testInfo,
        'runtime-allowed',
        'terminal.restart',
        { terminalId: 'missing-terminal', mode: 'resume' },
        'NOT_FOUND',
    );
});
