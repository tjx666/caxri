import { writeFileSync } from 'node:fs';

import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import {
    assertE2EErrorPolicy,
    type E2EErrorAllowance,
    type E2EErrorEvent,
} from '../src/shared/node/e2e-error-policy.ts';
import {
    parseE2ELogErrors,
    readE2ELogSnapshots,
    type E2ELogSnapshot,
} from '../src/shared/node/e2e-error-log.ts';
import {
    createE2ELaunchFinalizer,
    type E2ELaunchFinalizer,
} from '../src/shared/node/e2e-launch-finalizer.ts';
let activeGate: E2EErrorGate | undefined;

interface E2ELaunch {
    app: ElectronApplication;
    finalizer: E2ELaunchFinalizer;
    userDataDir: string;
}

class E2EErrorGate {
    private readonly allowances: E2EErrorAllowance[] = [];
    private readonly attachedPages = new WeakSet<Page>();
    private readonly directErrors: E2EErrorEvent[] = [];
    private readonly logSnapshots = new Map<string, E2ELogSnapshot>();
    private readonly launches: E2ELaunch[] = [];
    private readonly captureFailures: unknown[] = [];
    private readonly pendingAttachments: Promise<void>[] = [];
    private attachmentIndex = 0;

    constructor(private readonly testInfo: TestInfo) {}

    allow(allowances: readonly E2EErrorAllowance[]): void {
        this.allowances.push(...allowances);
    }

    register(app: ElectronApplication, userDataDir: string, cleanup: () => Promise<void>): void {
        const finalizer = createE2ELaunchFinalizer(cleanup);
        this.launches.push({ app, finalizer, userDataDir });
        for (const page of app.windows()) this.attachPage(page);
        app.on('window', (page) => this.attachPage(page));
        app.once('close', () => {
            try {
                this.captureLogs(userDataDir);
            } catch (error) {
                this.captureFailures.push(error);
            } finally {
                void finalizer.begin().catch(() => undefined);
            }
        });
    }

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

    /** Captures and attaches log bodies synchronously before tests remove their temporary profile. */
    private captureLogs(userDataDir: string): void {
        for (const snapshot of readE2ELogSnapshots(userDataDir)) {
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

    async finish(): Promise<void> {
        const finalizations = await Promise.allSettled(
            this.launches.map(({ app, finalizer }) => finalizer.finish(() => app.close())),
        );
        const finalizationFailures: unknown[] = [];
        for (const result of finalizations) {
            if (result.status === 'rejected') finalizationFailures.push(result.reason as unknown);
        }
        for (const { userDataDir } of this.launches) {
            try {
                this.captureLogs(userDataDir);
            } catch (error) {
                this.captureFailures.push(error);
            }
        }
        await Promise.all(this.pendingAttachments);
        const teardownFailures = [...finalizationFailures, ...this.captureFailures];
        if (teardownFailures.length > 0)
            throw new AggregateError(teardownFailures, 'Could not finalize E2E launches');
        const logErrors = parseE2ELogErrors([...this.logSnapshots.values()]);
        assertE2EErrorPolicy([...this.directErrors, ...logErrors], this.allowances);
    }
}

export async function runWithE2EErrorGate(
    testInfo: TestInfo,
    runTest: () => Promise<void>,
): Promise<void> {
    const gate = new E2EErrorGate(testInfo);
    if (activeGate) throw new Error('Only one E2E error gate may run in a worker at a time');
    activeGate = gate;
    try {
        await runTest();
    } finally {
        try {
            await gate.finish();
        } finally {
            activeGate = undefined;
        }
    }
}

export function registerE2ELaunch(
    app: ElectronApplication,
    userDataDir: string,
    cleanup: () => Promise<void>,
): void {
    const gate = activeGate;
    if (!gate) throw new Error('launchCaxri must run inside the shared E2E test fixture');
    gate.register(app, userDataDir, cleanup);
}

/** Declares exact errors that must be observed and consumed by the current E2E test. */
export function allowE2EErrors(allowances: readonly E2EErrorAllowance[]): void {
    const gate = activeGate;
    if (!gate) throw new Error('allowE2EErrors must run inside the shared E2E test fixture');
    gate.allow(allowances);
}
