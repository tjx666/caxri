import { writeFileSync } from 'node:fs';

import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import type { E2ELogSnapshot } from '../../src/shared/node/e2e-error-log.ts';
import { parseE2ELogErrors, readE2ELogSnapshots } from '../../src/shared/node/e2e-error-log.ts';
import type { E2EErrorAllowance, E2EErrorEvent } from '../../src/shared/node/e2e-error-policy.ts';
import { assertE2EErrorPolicy } from '../../src/shared/node/e2e-error-policy.ts';
import type { E2ELaunchFinalizer } from '../../src/shared/node/e2e-launch-finalizer.ts';
import { createE2ELaunchFinalizer } from '../../src/shared/node/e2e-launch-finalizer.ts';

const gateState: { current: E2EErrorGate | undefined } = { current: undefined };

interface E2ELaunch {
    app: ElectronApplication;
    finalizer: E2ELaunchFinalizer;
    userDataDirectory: string;
}

class E2EErrorGate {
    private readonly allowances: E2EErrorAllowance[] = [];
    private readonly attachedPages = new WeakSet<Page>();
    private readonly directErrors: E2EErrorEvent[] = [];
    private readonly logSnapshots = new Map<string, E2ELogSnapshot>();
    private readonly launches: E2ELaunch[] = [];
    private readonly captureFailures: unknown[] = [];
    private readonly pendingAttachments: Array<Promise<void>> = [];
    private attachmentIndex = 0;

    constructor(private readonly testInfo: TestInfo) {}

    private attachPage(page: Page): void {
        if (this.attachedPages.has(page)) return;
        this.attachedPages.add(page);
        page.on('pageerror', () => {
            this.directErrors.push({
                source: 'renderer',
                event: 'pageerror',
                code: 'PAGE_ERROR',
            });
        });
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            this.directErrors.push({
                source: 'renderer',
                event: 'console',
                code: 'CONSOLE_ERROR',
            });
        });
    }

    /**
    Captures and attaches log bodies synchronously before tests remove their temporary profile.
     */
    private captureLogs(userDataDirectory: string): void {
        for (const snapshot of readE2ELogSnapshots(userDataDirectory)) {
            const { contents, path, source } = snapshot;
            if (this.logSnapshots.get(path)?.contents === contents) continue;
            this.logSnapshots.set(path, snapshot);
            this.attachmentIndex += 1;
            const rotation = path.endsWith('.jsonl.1') ? '-rotated' : '';
            const attachmentName = `caxri-${source}${rotation}-${this.attachmentIndex.toString().padStart(2, '0')}.jsonl`;
            const attachmentPath = this.testInfo.outputPath(attachmentName);
            writeFileSync(attachmentPath, contents, { encoding: 'utf8', mode: 0o600 });
            this.pendingAttachments.push(
                this.testInfo.attach(attachmentName, {
                    path: attachmentPath,
                    contentType: 'application/x-ndjson',
                }),
            );
        }
    }

    allow(allowances: readonly E2EErrorAllowance[]): void {
        this.allowances.push(...allowances);
    }

    register(
        app: ElectronApplication,
        userDataDirectory: string,
        cleanup: () => Promise<void>,
    ): void {
        const finalizer = createE2ELaunchFinalizer(cleanup);
        this.launches.push({ app, finalizer, userDataDirectory });
        for (const page of app.windows()) this.attachPage(page);
        app.on('window', (page) => this.attachPage(page));
        app.once('close', async () => {
            try {
                this.captureLogs(userDataDirectory);
            } catch (error) {
                this.captureFailures.push(error);
            } finally {
                try {
                    await finalizer.begin();
                } catch {
                    // Finalization failures surface through `finish()`'s settled results.
                }
            }
        });
    }

    async finish(): Promise<void> {
        const finalizations = await Promise.allSettled(
            this.launches.map(({ app, finalizer }) => finalizer.finish(() => app.close())),
        );
        const finalizationFailures: unknown[] = [];
        for (const result of finalizations) {
            if (result.status === 'rejected') finalizationFailures.push(result.reason as unknown);
        }
        for (const { userDataDirectory } of this.launches) {
            try {
                this.captureLogs(userDataDirectory);
            } catch (error) {
                this.captureFailures.push(error);
            }
        }
        await Promise.all(this.pendingAttachments);
        const teardownFailures = [...finalizationFailures, ...this.captureFailures];
        if (teardownFailures.length > 0)
            throw new AggregateError(teardownFailures, 'Could not finalize E2E launches');
        const logErrors = parseE2ELogErrors(this.logSnapshots.values().toArray());
        assertE2EErrorPolicy([...this.directErrors, ...logErrors], this.allowances);
    }
}

export async function runWithE2EErrorGate(
    testInfo: TestInfo,
    runTest: () => Promise<void>,
): Promise<void> {
    if (gateState.current) throw new Error('Only one E2E error gate may run in a worker at a time');
    const gate = new E2EErrorGate(testInfo);
    gateState.current = gate;
    try {
        await runTest();
    } finally {
        try {
            await gate.finish();
        } finally {
            gateState.current = undefined;
        }
    }
}

export function registerE2ELaunch(
    app: ElectronApplication,
    userDataDirectory: string,
    cleanup: () => Promise<void>,
): void {
    const gate = gateState.current;
    if (!gate) throw new Error('launchCaxri must run inside the shared E2E test fixture');
    gate.register(app, userDataDirectory, cleanup);
}

/**
Declares exact errors that must be observed and consumed by the current E2E test.
 */
export function allowE2EErrors(allowances: readonly E2EErrorAllowance[]): void {
    const gate = gateState.current;
    if (!gate) throw new Error('allowE2EErrors must run inside the shared E2E test fixture');
    gate.allow(allowances);
}
