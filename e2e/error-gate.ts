import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import {
    assertE2EErrorPolicy,
    type E2EErrorAllowance,
    type E2EErrorEvent,
    type E2EErrorSource,
} from '../src/shared/node/e2e-error-policy.ts';

interface StructuredErrorRecord {
    event?: unknown;
    fields?: Record<string, unknown>;
    level?: unknown;
    process?: unknown;
}

const fatalLogEvents = new Set([
    'process_explorer.render_process_gone',
    'window.render_process_gone',
]);
let activeGate: E2EErrorGate | undefined;

function fallbackCode(event: string): string {
    return event.replaceAll(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function errorFromLog(record: StructuredErrorRecord): E2EErrorEvent | undefined {
    if (record.process !== 'main' && record.process !== 'runtime') return undefined;
    if (typeof record.event !== 'string') return undefined;
    if (record.level !== 'error' && record.level !== 'fatal' && !fatalLogEvents.has(record.event))
        return undefined;
    return {
        source: record.process,
        event: record.event,
        code:
            typeof record.fields?.code === 'string'
                ? record.fields.code
                : fallbackCode(record.event),
    };
}

function parseLogErrors(contents: string, source: E2EErrorSource): E2EErrorEvent[] {
    const errors: E2EErrorEvent[] = [];
    for (const line of contents.split('\n')) {
        if (!line) continue;
        try {
            const error = errorFromLog(JSON.parse(line) as StructuredErrorRecord);
            if (error) errors.push(error);
        } catch {
            errors.push({ source, event: 'e2e.log_invalid', code: 'INVALID_JSONL' });
        }
    }
    return errors;
}

class E2EErrorGate {
    private readonly allowances: E2EErrorAllowance[] = [];
    private readonly attachedPages = new WeakSet<Page>();
    private readonly directErrors: E2EErrorEvent[] = [];
    private readonly logSnapshots = new Map<string, string>();
    private readonly launches = new Set<string>();
    private readonly pendingAttachments: Promise<void>[] = [];
    private attachmentIndex = 0;

    constructor(private readonly testInfo: TestInfo) {}

    allow(allowances: readonly E2EErrorAllowance[]): void {
        this.allowances.push(...allowances);
    }

    register(app: ElectronApplication, userDataDir: string): void {
        this.launches.add(userDataDir);
        for (const page of app.windows()) this.attachPage(page);
        app.on('window', (page) => this.attachPage(page));
        app.once('close', () => this.captureLogs(userDataDir));
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
        for (const processName of ['main', 'runtime'] as const) {
            const path = join(userDataDir, 'logs', `${processName}.jsonl`);
            let contents: string;
            try {
                contents = readFileSync(path, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
            if (this.logSnapshots.get(path) === contents) continue;
            this.logSnapshots.set(path, contents);
            this.attachmentIndex += 1;
            const attachmentName = `caxri-${processName}-${this.attachmentIndex.toString().padStart(2, '0')}.jsonl`;
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
        for (const userDataDir of this.launches) this.captureLogs(userDataDir);
        await Promise.all(this.pendingAttachments);
        const logErrors = [...this.logSnapshots].flatMap(([path, contents]) =>
            parseLogErrors(contents, path.endsWith('/runtime.jsonl') ? 'runtime' : 'main'),
        );
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

export function registerE2ELaunch(app: ElectronApplication, userDataDir: string): void {
    const gate = activeGate;
    if (!gate) throw new Error('launchCaxri must run inside the shared E2E test fixture');
    gate.register(app, userDataDir);
}

/** Declares exact errors that must be observed and consumed by the current E2E test. */
export function allowE2EErrors(allowances: readonly E2EErrorAllowance[]): void {
    const gate = activeGate;
    if (!gate) throw new Error('allowE2EErrors must run inside the shared E2E test fixture');
    gate.allow(allowances);
}
