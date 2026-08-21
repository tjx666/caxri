import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { ElectronApplication } from '@playwright/test';

const NATIVE_HELPER_PATH = join(import.meta.dirname, 'clipboard-native.swift');

export interface ClipboardMetadata {
    formatCount: number;
    generation: number;
    itemCount: number;
}

interface ClipboardSnapshotRecord extends ClipboardMetadata {
    payload: string;
}

export interface ClipboardRestoreOutcome {
    generation: number;
    status: 'restored' | 'skipped-external-write';
}

export interface ClipboardNativeAdapter {
    claimImage: () => Promise<number>;
    claimText: (expectedText: string) => Promise<number>;
    matchesFixture: (fixture: ClipboardFixture) => Promise<boolean>;
    matchesSnapshot: (payload: string) => Promise<boolean>;
    restore: (payload: string, expectedGeneration: number) => Promise<ClipboardRestoreOutcome>;
    snapshot: () => Promise<ClipboardSnapshotRecord>;
    writeFixture: (fixture: ClipboardFixture) => Promise<ClipboardMetadata>;
}

export type ClipboardFixture = 'custom-formats' | 'external-write';

function contentFreeNativeError(action: string): Error {
    return new Error(`Could not ${action} the native E2E clipboard`);
}

/**
 * Runs the AppKit boundary with structured argv and sends snapshot bytes only over stdin/stdout. Clipboard payloads
 * never enter process arguments, logs, thrown errors, or Playwright protocol artifacts.
 */
async function runNativeHelper(command: string, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/swift', [NATIVE_HELPER_PATH, command], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const output: Buffer[] = [];
        let isSettled = false;
        const rejectOnce = (): void => {
            if (isSettled) return;
            isSettled = true;
            reject(contentFreeNativeError(`run ${command} for`));
        };
        child.once('error', rejectOnce);
        child.stdout.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
        child.stderr.resume();
        child.stdin.on('error', () => {
            // The exit handler below reports a content-free failure if the helper closes stdin early.
        });
        child.once('close', (code) => {
            if (isSettled) return;
            if (code !== 0) {
                rejectOnce();
                return;
            }
            isSettled = true;
            resolve(Buffer.concat(output).toString('utf8'));
        });
        child.stdin.end(input);
    });
}

function parseNativeObject(output: string, action: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(output);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        // The caller receives a content-free protocol error below.
    }
    throw contentFreeNativeError(`parse ${action} metadata from`);
}

function numericField(record: Record<string, unknown>, field: string, action: string): number {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw contentFreeNativeError(`parse ${action} metadata from`);
    }
    return value;
}

function metadata(record: Record<string, unknown>, action: string): ClipboardMetadata {
    return {
        formatCount: numericField(record, 'formatCount', action),
        generation: numericField(record, 'generation', action),
        itemCount: numericField(record, 'itemCount', action),
    };
}

const nativePasteboard: ClipboardNativeAdapter = {
    claimImage: async () => {
        const record = parseNativeObject(await runNativeHelper('claim-image'), 'image claim');
        return numericField(record, 'generation', 'image claim');
    },
    claimText: async (expectedText) => {
        const record = parseNativeObject(
            await runNativeHelper('claim-text', JSON.stringify({ text: expectedText })),
            'text claim',
        );
        return numericField(record, 'generation', 'text claim');
    },
    matchesFixture: async (fixture) => {
        const record = parseNativeObject(
            await runNativeHelper(`matches-${fixture}`),
            'fixture comparison',
        );
        if (typeof record.matches !== 'boolean') {
            throw contentFreeNativeError('parse fixture comparison metadata from');
        }
        return record.matches;
    },
    matchesSnapshot: async (payload) => {
        const record = parseNativeObject(
            await runNativeHelper('matches-snapshot', JSON.stringify({ payload })),
            'snapshot comparison',
        );
        if (typeof record.matches !== 'boolean') {
            throw contentFreeNativeError('parse snapshot comparison metadata from');
        }
        return record.matches;
    },
    restore: async (payload, expectedGeneration) => {
        const record = parseNativeObject(
            await runNativeHelper('restore', JSON.stringify({ expectedGeneration, payload })),
            'restore',
        );
        const status = record.status;
        if (status !== 'restored' && status !== 'skipped-external-write') {
            throw contentFreeNativeError('parse restore metadata from');
        }
        return {
            generation: numericField(record, 'generation', 'restore'),
            status,
        };
    },
    snapshot: async () => {
        const record = parseNativeObject(await runNativeHelper('snapshot'), 'snapshot');
        if (typeof record.payload !== 'string' || record.payload.length === 0) {
            throw contentFreeNativeError('parse snapshot metadata from');
        }
        return { ...metadata(record, 'snapshot'), payload: record.payload };
    },
    writeFixture: async (fixture) => {
        const record = parseNativeObject(
            await runNativeHelper(`write-${fixture}`),
            'fixture write',
        );
        return metadata(record, 'fixture write');
    },
};

/**
 * Owns one clipboard snapshot and the last pasteboard generation explicitly produced by this E2E launch. Restore is
 * serialized and idempotent so Playwright close, native quit, and the error-gate finalizer cannot race each other.
 */
export class ClipboardSnapshot {
    private ownedGeneration: number;
    private restoreEndpoint?: { server: Server; url: string };
    private restorePromise?: Promise<ClipboardRestoreOutcome>;
    readonly metadata: ClipboardMetadata;

    constructor(
        private readonly record: ClipboardSnapshotRecord,
        private readonly native: ClipboardNativeAdapter,
    ) {
        this.metadata = {
            formatCount: record.formatCount,
            generation: record.generation,
            itemCount: record.itemCount,
        };
        this.ownedGeneration = record.generation;
    }

    /**
     * Accepts a generation receipt returned by the same native write or verified restore boundary. An external mutation
     * after that operation changes the generation, so compare-and-restore skips restoration.
     */
    claimGeneration(generation: number): void {
        if (this.restorePromise) throw new Error('The E2E clipboard restore is already finalized');
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new Error('The E2E clipboard generation receipt is invalid');
        }
        this.ownedGeneration = generation;
    }

    async claimImage(): Promise<void> {
        if (this.restorePromise) throw new Error('The E2E clipboard restore is already finalized');
        try {
            this.ownedGeneration = await this.native.claimImage();
        } catch {
            throw new Error('Could not claim E2E image clipboard ownership');
        }
    }

    async claimText(expectedText: string): Promise<void> {
        if (this.restorePromise) throw new Error('The E2E clipboard restore is already finalized');
        try {
            this.ownedGeneration = await this.native.claimText(expectedText);
        } catch {
            throw new Error('Could not claim E2E text clipboard ownership');
        }
    }

    async matchesSnapshot(): Promise<boolean> {
        try {
            return await this.native.matchesSnapshot(this.record.payload);
        } catch {
            throw new Error('Could not compare the E2E clipboard snapshot');
        }
    }

    async restore(): Promise<ClipboardRestoreOutcome> {
        this.restorePromise ??= (async () => {
            try {
                const outcome = await this.native.restore(
                    this.record.payload,
                    this.ownedGeneration,
                );
                if (
                    outcome.status === 'restored' &&
                    !(await this.native.matchesSnapshot(this.record.payload))
                ) {
                    throw new Error('Native pasteboard reconstruction was incomplete');
                }
                return outcome;
            } catch {
                throw new Error('Could not restore the E2E clipboard');
            }
        })();
        return this.restorePromise;
    }

    async restoreOutcome(): Promise<ClipboardRestoreOutcome | undefined> {
        return this.restorePromise;
    }

    /**
     * Exposes only a random loopback capability to Electron. Snapshot bytes stay in the Playwright runner and native
     * helper while graceful app.quit() reaches the same restore promise as the wrapped app.close() path.
     */
    async restoreUrl(): Promise<string> {
        if (this.restoreEndpoint) return this.restoreEndpoint.url;
        const token = randomUUID();
        const route = `/clipboard-restore/${token}`;
        const server = createServer((request, response) => {
            if (request.method !== 'POST' || request.url !== route) {
                response.statusCode = 404;
                response.end();
                return;
            }
            request.resume();
            // eslint-disable-next-line no-void -- Node's request callback cannot await the serialized restore promise
            void this.restore()
                .then(() => {
                    response.statusCode = 204;
                })
                .catch(() => {
                    response.statusCode = 500;
                })
                .finally(() => {
                    response.setHeader('Cache-Control', 'no-store');
                    response.end();
                });
        });
        await new Promise<void>((resolve, reject) => {
            const handleError = (): void =>
                reject(new Error('Could not arm E2E clipboard restore'));
            server.once('error', handleError);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', handleError);
                resolve();
            });
        });
        const address = server.address() as AddressInfo | null;
        if (!address) {
            server.close();
            throw new Error('Could not arm E2E clipboard restore');
        }
        server.unref();
        const url = `http://127.0.0.1:${address.port}${route}`;
        this.restoreEndpoint = { server, url };
        return url;
    }

    async dispose(): Promise<void> {
        const endpoint = this.restoreEndpoint;
        this.restoreEndpoint = undefined;
        if (endpoint) {
            await new Promise<void>((resolve, reject) => {
                endpoint.server.close((error) => {
                    if (error) reject(new Error('Could not close E2E clipboard restore'));
                    else resolve();
                });
            });
        }
        if (this.restorePromise) await this.restorePromise;
    }
}

export async function snapshotClipboard(
    native: ClipboardNativeAdapter = nativePasteboard,
): Promise<ClipboardSnapshot> {
    try {
        return new ClipboardSnapshot(await native.snapshot(), native);
    } catch {
        throw new Error('Could not snapshot the E2E clipboard');
    }
}

/**
 * Arms a native-quit guardian without transferring clipboard bytes through Playwright. The first before-quit event is
 * delayed only until the loopback restore request settles; the second quit proceeds after the one-shot listener is
 * removed. SIGKILL intentionally has no restoration guarantee.
 */
export async function armClipboardRestoreOnQuit(
    app: ElectronApplication,
    snapshot: ClipboardSnapshot,
): Promise<void> {
    const restoreUrl = await snapshot.restoreUrl();
    await app.evaluate(({ app: electronApp }, url) => {
        electronApp.once('before-quit', (event) => {
            event.preventDefault();
            // eslint-disable-next-line no-void -- Electron quit resumes from the promise finalizer after the one-shot listener is removed
            void fetch(url, {
                method: 'POST',
                signal: AbortSignal.timeout(10_000),
            })
                .catch(() => {})
                .finally(() => electronApp.quit());
        });
    }, restoreUrl);
}

export async function restoreClipboard(snapshot: ClipboardSnapshot): Promise<void> {
    await snapshot.restore();
}

/**
 * Compares inside Electron so real clipboard text never crosses into Playwright assertions or failure artifacts.
 */
export async function isClipboardTextEqual(
    app: ElectronApplication,
    expectedText: string,
): Promise<boolean> {
    return app.evaluate(
        ({ clipboard }, expected) => clipboard.readText() === expected,
        expectedText,
    );
}

export async function writeTestClipboardText(
    app: ElectronApplication,
    snapshot: ClipboardSnapshot,
    text: string,
): Promise<void> {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
    await snapshot.claimText(text);
}

export async function writeClipboardFixture(
    fixture: ClipboardFixture,
    native: ClipboardNativeAdapter = nativePasteboard,
): Promise<ClipboardMetadata> {
    try {
        return await native.writeFixture(fixture);
    } catch {
        throw new Error('Could not write the E2E clipboard fixture');
    }
}

export async function isClipboardFixtureCurrent(
    fixture: ClipboardFixture,
    native: ClipboardNativeAdapter = nativePasteboard,
): Promise<boolean> {
    try {
        return await native.matchesFixture(fixture);
    } catch {
        throw new Error('Could not compare the E2E clipboard fixture');
    }
}
