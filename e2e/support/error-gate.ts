import { writeFileSync } from 'node:fs';

import type {
    E2EErrorAllowance,
    E2EErrorEvent,
    E2ELaunchFinalizer,
    E2ELogSnapshot,
} from '@caxri/system';
import {
    assertE2EErrorPolicy,
    createE2ELaunchFinalizer,
    parseE2ELogErrors,
    readE2ELogSnapshots,
} from '@caxri/system';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

const gateState: { current: E2EErrorGate | undefined } = { current: undefined };

const ERROR_TOAST_BINDING = '__caxriE2EReportErrorToast';

interface ObservedToastDocument extends Document {
    __caxriE2EErrorToastReports?: Array<Promise<void>>;
}

/**
 * Runs inside each document, including after reload. Observe notification lifetimes instead of sampling the final DOM:
 * Sonner expires errors and updates duplicate notifications in place. Never transport notification text or attributes.
 */
function observeErrorToasts(binding: string): void {
    /**
     * Fixed product copy only; error details may contain paths or user content.
     */
    const classify = (element: Element): string => {
        const title = element.querySelector('[data-title]')?.textContent ?? '';
        if (title.includes('Projects and Sessions from the Server')) return 'workbench.snapshot';
        if (title.startsWith('Session layout could not be saved')) return 'session.layout';
        if (title.startsWith('Session selection failed')) return 'session.select';
        if (title.startsWith('Session creation failed')) return 'session.create';
        if (title.startsWith('Project creation failed')) return 'project.create';
        if (title.startsWith('Another Caxri window took over this profile')) return 'host.replaced';
        if (title.startsWith('Source Control refresh failed')) return 'source-control.refresh';
        if (title.startsWith('Unable to read directory')) return 'files.directory';
        if (title.startsWith('Unable to list Workbench Roots')) return 'workbench.roots';
        if (title.startsWith('Unable to activate Terminal')) return 'terminal.activate';
        if (title.startsWith('Terminal creation failed')) return 'terminal.create';
        if (title.startsWith('Terminal close failed')) return 'terminal.close';
        if (title.startsWith('Terminal input failed')) return 'terminal.input';
        if (title.startsWith('Unable to send Agent command or skill')) return 'agent.action';
        if (title.startsWith('Unable to save recent Agent action')) return 'agent.recent';
        if (title.startsWith('Project icon update failed')) return 'project.icon';
        if (title.startsWith('Unable to continue in worktree')) return 'workbench.continue';
        if (title === 'CAXRI_EXPECTED_E2E_TOAST') return 'e2e.injected';
        return 'unclassified';
    };
    const target = document as ObservedToastDocument;
    if (target.__caxriE2EErrorToastReports) return;
    const reports: Array<Promise<void>> = [];
    Object.defineProperty(target, '__caxriE2EErrorToastReports', { value: reports });
    const seen = new WeakSet<Element>();
    const selector = '[data-sonner-toast][data-type="error"]';
    const record = (element: Element): void => {
        if (!element.matches(selector) || seen.has(element)) return;
        seen.add(element);
        // Await acknowledgements before Electron closes; fire-and-forget console events can lose this race.
        reports.push(
            (globalThis as unknown as Record<string, (category: string) => Promise<void>>)[binding](
                classify(element),
            ),
        );
    };
    const scan = (node: Node): void => {
        if (!(node instanceof Element)) return;
        record(node);
        for (const element of node.querySelectorAll(selector)) record(element);
    };
    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') scan(mutation.target);
            else {
                for (const node of mutation.addedNodes) scan(node);
                // Also cover a notification inserted and removed in the same task, before the observer runs.
                for (const node of mutation.removedNodes) scan(node);
            }
        }
    }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-sonner-toast', 'data-type'],
    });
    for (const element of document.querySelectorAll(selector)) record(element);
}

interface E2ELaunch {
    app: ElectronApplication;
    finalizer: E2ELaunchFinalizer;
    userDataDirectory: string;
}

/**
 * Says whether the run recorded any Main or Server error at all beside its notifications.
 *
 * A notification names a symptom; the structured log names the cause. When both are present the failure text already
 * pairs them: that is how `session.updateState` was identified as the `NOT_FOUND` behind a `terminal.activate`
 * notification. When the log side is empty the reader has to know that this is itself evidence rather than a gap in
 * capture: the remaining sources are a Renderer-local failure, and a request refused after quit began, which
 * `apps/desktop/src/main/workbench-ipc.ts` deliberately does not log because a cancellation is an expected outcome. Two
 * intermittent cases (#877) stalled on rediscovering that by hand, so state it in the failure instead.
 */
function describeToastCorrelation(logErrors: readonly E2EErrorEvent[]): string {
    if (logErrors.length > 0) return '';
    return ' (no Main or Server error was logged in this run, so the cause is Renderer-local or a request cancelled at quit)';
}

class E2EErrorGate {
    private readonly allowances: E2EErrorAllowance[] = [];
    private readonly attachedPages = new WeakSet<Page>();
    private readonly crashedPages = new WeakSet<Page>();
    private readonly directErrors: E2EErrorEvent[] = [];
    private readonly toastCategories: string[] = [];
    private readonly logSnapshots = new Map<string, E2ELogSnapshot>();
    private readonly launches: E2ELaunch[] = [];
    private readonly captureFailures: unknown[] = [];
    private readonly pendingAttachments: Array<Promise<void>> = [];
    private attachmentIndex = 0;

    constructor(private readonly testInfo: TestInfo) {}

    private attachPage(page: Page): void {
        if (this.attachedPages.has(page)) return;
        this.attachedPages.add(page);
        page.on('crash', () => this.crashedPages.add(page));
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
     * Captures and attaches log bodies synchronously before tests remove their temporary profile.
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

    async register(
        app: ElectronApplication,
        userDataDirectory: string,
        cleanup: () => Promise<void>,
    ): Promise<void> {
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
        const context = app.context();
        await context.exposeBinding(ERROR_TOAST_BINDING, (_source, category: string) => {
            this.directErrors.push({ source: 'renderer', event: 'toast', code: 'ERROR_TOAST' });
            this.toastCategories.push(category);
        });
        await context.addInitScript(observeErrorToasts, ERROR_TOAST_BINDING);
        await Promise.all(
            context.pages().map((page) => page.evaluate(observeErrorToasts, ERROR_TOAST_BINDING)),
        );
    }

    /**
     * Flush the browser-to-runner acknowledgements before the separate Electron connection destroys the windows.
     */
    async flushToasts(app: ElectronApplication): Promise<void> {
        await Promise.all(
            app
                .context()
                .pages()
                .map(async (page) => {
                    if (page.isClosed() || this.crashedPages.has(page)) return;
                    try {
                        await page.evaluate(async () => {
                            const reports = (document as ObservedToastDocument)
                                .__caxriE2EErrorToastReports;
                            if (!reports)
                                throw new Error('E2E error-toast observer is unavailable');
                            await Promise.all(reports);
                        });
                    } catch (error) {
                        if (!page.isClosed() && !this.crashedPages.has(page)) {
                            // Several specs ignore app.close() errors; the fixture must still reject failed capture.
                            this.captureFailures.push(error);
                            throw error;
                        }
                    }
                }),
        );
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
        try {
            assertE2EErrorPolicy([...this.directErrors, ...logErrors], this.allowances);
        } catch (error) {
            if (this.toastCategories.length === 0) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `${message}; toast categories: ${this.toastCategories.join(', ')}${describeToastCorrelation(logErrors)}`,
                { cause: error },
            );
        }
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

export async function registerE2ELaunch(
    app: ElectronApplication,
    userDataDirectory: string,
    cleanup: () => Promise<void>,
): Promise<void> {
    const gate = gateState.current;
    if (!gate) throw new Error('launchCaxri must run inside the shared E2E test fixture');
    await gate.register(app, userDataDirectory, cleanup);
}

export async function flushE2EErrorToasts(app: ElectronApplication): Promise<void> {
    await gateState.current?.flushToasts(app);
}

/**
 * Declares exact errors that must be observed and consumed by the current E2E test.
 */
export function allowE2EErrors(allowances: readonly E2EErrorAllowance[]): void {
    const gate = gateState.current;
    if (!gate) throw new Error('allowE2EErrors must run inside the shared E2E test fixture');
    gate.allow(allowances);
}
