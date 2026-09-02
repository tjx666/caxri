import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { runWithE2EErrorGate } from './support/error-gate.ts';
import type { TestInfo } from './support/fixtures.ts';
import { allowE2EErrors, errorGateSelfTest, expect, test } from './support/fixtures.ts';
import { launchCaxri, pageReply } from './support/helpers.ts';

async function observeIpcFailure(
    testInfo: TestInfo,
    name: string,
    method: string,
    parameters: unknown,
    expectedCode: string,
): Promise<void> {
    const testDirectory = await mkdtemp(join(tmpdir(), `caxri-error-gate-${name}-`));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect(running.page.getByRole('tree', { name: 'Primary Side Bar' })).toBeAttached();
        const reply = await pageReply(running.page, method, parameters);
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error.code).toBe(expectedCode);
        await expect(running.page.getByRole('tree', { name: 'Primary Side Bar' })).toBeAttached();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await expect
            .poll(() => ({
                desktop: testInfo.attachments.some((attachment) =>
                    attachment.name.startsWith('caxri-desktop-'),
                ),
                server: testInfo.attachments.some((attachment) =>
                    attachment.name.startsWith('caxri-server-core-'),
                ),
            }))
            .toEqual({ desktop: true, server: true });
        await rm(testDirectory, { recursive: true, force: true });
    }
}

/**
 * Runs the real gate directly so a negative regression can assert its exact teardown rejection.
 */
async function expectGateFailure(
    testInfo: TestInfo,
    expectedMessage: string,
    runTest: () => Promise<void>,
): Promise<void> {
    let isBodyCompleted = false;
    let failure: unknown;
    try {
        await runWithE2EErrorGate(testInfo, async () => {
            await runTest();
            isBodyCompleted = true;
        });
    } catch (error) {
        failure = error;
    }
    expect(isBodyCompleted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedMessage);
}

test('issue-104-error-gate: observes a page exception while the UI remains usable', async () => {
    allowE2EErrors([
        {
            source: 'desktop',
            event: 'renderer.page_exception',
            code: 'PAGE_EXCEPTION',
            count: 1,
        },
        {
            source: 'desktop',
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
            }, 0);
        });
        const mainLogPath = join(userData, 'logs', 'desktop.jsonl');
        await expect
            .poll(() => readFile(mainLogPath, 'utf8'))
            .toContain('"event":"renderer.page_exception"');
        await expect(running.page.getByRole('tree', { name: 'Primary Side Bar' })).toBeAttached();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * `project.create` with a `rootPath` that was never granted through the folder-picker flow fails entirely inside
 * Desktop's {@link ../../apps/desktop/src/main/root-grants.ts | ProjectRootGrants} before any Server round trip, so it
 * stays at `error` level even though `NOT_FOUND` and `VALIDATION` demote to `warn` for ordinary caller-side input.
 */
const UNGRANTED_ROOT_PATH = '/caxri-e2e-error-gate-ungranted-root';

errorGateSelfTest(
    'issue-104-error-gate: rejects an unexpected Desktop error after usable UI',
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to be an object destructuring pattern
    async ({}, testInfo) => {
        await expectGateFailure(
            testInfo,
            'Unexpected E2E errors: desktop/ipc.request_failed/PATH_DENIED x1 [methods: project.create]',
            () =>
                observeIpcFailure(
                    testInfo,
                    'desktop-unallowed',
                    'project.create',
                    { rootPath: UNGRANTED_ROOT_PATH },
                    'PATH_DENIED',
                ),
        );
    },
);

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to be an object destructuring pattern
test('issue-104-error-gate: consumes one exact Desktop error after usable UI', async ({}, testInfo) => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
    ]);
    await observeIpcFailure(
        testInfo,
        'desktop-allowed',
        'project.create',
        { rootPath: UNGRANTED_ROOT_PATH },
        'PATH_DENIED',
    );
});

errorGateSelfTest(
    'issue-104-error-gate: rejects an unexpected Server error after usable UI',
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to be an object destructuring pattern
    async ({}, testInfo) => {
        await expectGateFailure(
            testInfo,
            'Unexpected E2E errors: server-core/ipc.request_failed/NOT_FOUND x1 [methods: terminal.restart]',
            () =>
                observeIpcFailure(
                    testInfo,
                    'server-unallowed',
                    'terminal.restart',
                    { terminalId: 'missing-terminal', mode: 'resume' },
                    'NOT_FOUND',
                ),
        );
    },
);

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to be an object destructuring pattern
test('issue-104-error-gate: consumes one exact Server error after usable UI', async ({}, testInfo) => {
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    await observeIpcFailure(
        testInfo,
        'server-allowed',
        'terminal.restart',
        { terminalId: 'missing-terminal', mode: 'resume' },
        'NOT_FOUND',
    );
});
