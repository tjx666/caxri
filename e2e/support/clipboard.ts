import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { ElectronApplication } from '@playwright/test';

const NATIVE_HELPER_PATH = join(import.meta.dirname, 'clipboard-native.swift');
const NATIVE_HELPER_MAX_TRANSPORT_BYTES = 64 * 1024 * 1024;
const NATIVE_HELPER_TIMEOUT_MS = 10_000;

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

export interface ClipboardCapability {
    readonly metadata: ClipboardMetadata;
    claimImage: () => Promise<void>;
    claimText: (expectedText: string) => Promise<void>;
    hasImage: () => Promise<boolean>;
    /**
     * Makes Main reject every later plain-text clipboard write, the path all Renderer copies take, so a spec can
     * exercise a copy failure without touching the system clipboard.
     */
    refuseTextWrites: () => Promise<void>;
    restoreOutcome: () => Promise<ClipboardRestoreOutcome | undefined>;
    textEquals: (expectedText: string) => Promise<boolean>;
    writePngBase64: (value: string) => Promise<void>;
    writeText: (value: string) => Promise<void>;
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

type NativeFailureReason =
    | 'input_limit'
    | 'output_limit'
    | 'ownership_mismatch'
    | 'process_failure'
    | 'protocol_failure'
    | 'spawn_failure'
    | 'timeout';

const nativeStages = [
    'claim-image',
    'claim-text',
    'snapshot',
    'restore',
    'matches-snapshot',
    'matches-custom-formats',
    'matches-external-write',
    'write-custom-formats',
    'write-external-write',
    'metadata',
    'native-helper',
] as const;
type NativeStage = (typeof nativeStages)[number];

/**
 * Only closed metadata crosses the helper boundary; never retain native errors, arguments, or output as a cause.
 */
export class ClipboardNativeError extends Error {
    constructor(
        readonly reason: NativeFailureReason,
        readonly stage: NativeStage,
        readonly durationMs: number,
    ) {
        super(`Native E2E clipboard ${stage} failed: ${reason} (${durationMs}ms)`);
        this.name = 'ClipboardNativeError';
    }
}

function contentFreeNativeError(action: string): Error {
    return new ClipboardNativeError(
        'protocol_failure',
        nativeStages.find((stage) => stage === action) ?? 'metadata',
        0,
    );
}

/**
 * Preserve only our closed diagnostic type; arbitrary adapter errors may contain clipboard data in their cause.
 */
function sanitizedClipboardFailure(error: unknown, message: string): Error {
    return error instanceof ClipboardNativeError ? error : new Error(message);
}

export interface NativeHelperRunOptions {
    executablePath: string;
    helperPath: string;
    maxInputBytes: number;
    maxOutputBytes: number;
    timeoutMs: number;
}

const defaultNativeHelperRunOptions: NativeHelperRunOptions = {
    executablePath: '/usr/bin/swift',
    helperPath: NATIVE_HELPER_PATH,
    maxInputBytes: NATIVE_HELPER_MAX_TRANSPORT_BYTES,
    maxOutputBytes: NATIVE_HELPER_MAX_TRANSPORT_BYTES,
    timeoutMs: NATIVE_HELPER_TIMEOUT_MS,
};

/**
 * Runs the AppKit boundary with structured argv and sends snapshot bytes only over stdin/stdout. Clipboard payloads
 * never enter process arguments, logs, thrown errors, or Playwright protocol artifacts.
 */
export async function runNativeHelper(
    command: string,
    input?: string,
    options: NativeHelperRunOptions = defaultNativeHelperRunOptions,
): Promise<string> {
    const startedAt = performance.now();
    const stage = nativeStages.find((value) => value === command) ?? 'native-helper';
    const failure = (reason: NativeFailureReason) =>
        new ClipboardNativeError(reason, stage, Math.round(performance.now() - startedAt));
    if (input && Buffer.byteLength(input) > options.maxInputBytes) {
        throw failure('input_limit');
    }
    return new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(options.executablePath, [options.helperPath, command], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch {
            reject(failure('spawn_failure'));
            return;
        }
        const output: Buffer[] = [];
        let outputBytes = 0;
        let isSettled = false;
        let terminationReason: NativeFailureReason | undefined;
        const timer = setTimeout(() => {
            terminationReason ??= 'timeout';
            child.kill('SIGKILL');
        }, options.timeoutMs);
        timer.unref();
        const rejectOnce = (reason: NativeFailureReason): void => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            reject(failure(reason));
        };
        child.once('error', () => rejectOnce('spawn_failure'));
        child.stdout!.on('data', (chunk: Buffer) => {
            if (isSettled || terminationReason) return;
            outputBytes += chunk.byteLength;
            if (outputBytes > options.maxOutputBytes) {
                terminationReason = 'output_limit';
                child.kill('SIGKILL');
                return;
            }
            output.push(Buffer.from(chunk));
        });
        child.stderr!.resume();
        child.stdin!.on('error', () => {
            // The exit handler below reports a content-free failure if the helper closes stdin early.
        });
        child.once('close', (code) => {
            if (isSettled) return;
            if (terminationReason || code !== 0) {
                rejectOnce(
                    terminationReason ??
                        (code === 3
                            ? 'ownership_mismatch'
                            : code === 2
                              ? 'protocol_failure'
                              : 'process_failure'),
                );
                return;
            }
            isSettled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(output).toString('utf8'));
        });
        child.stdin!.end(input);
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

/**
 * Injects the transport so malformed native responses can be tested without touching the desktop pasteboard.
 */
export function createClipboardNativeAdapter(
    run: typeof runNativeHelper = runNativeHelper,
): ClipboardNativeAdapter {
    const read = async <T>(
        command: NativeStage,
        input: string | undefined,
        decode: (record: Record<string, unknown>) => T,
    ): Promise<T> => {
        const startedAt = performance.now();
        try {
            return decode(parseNativeObject(await run(command, input), command));
        } catch (error) {
            if (error instanceof ClipboardNativeError && error.stage !== 'metadata') throw error;
            throw new ClipboardNativeError(
                'protocol_failure',
                command,
                Math.round(performance.now() - startedAt),
            );
        }
    };
    return {
        claimImage: async () => {
            return read('claim-image', undefined, (record) =>
                numericField(record, 'generation', 'image claim'),
            );
        },
        claimText: async (expectedText) => {
            return read('claim-text', JSON.stringify({ text: expectedText }), (record) =>
                numericField(record, 'generation', 'text claim'),
            );
        },
        matchesFixture: async (fixture) => {
            return read(`matches-${fixture}`, undefined, (record) => {
                if (typeof record.matches !== 'boolean') {
                    throw contentFreeNativeError('parse fixture comparison metadata from');
                }
                return record.matches;
            });
        },
        matchesSnapshot: async (payload) => {
            return read('matches-snapshot', JSON.stringify({ payload }), (record) => {
                if (typeof record.matches !== 'boolean') {
                    throw contentFreeNativeError('parse snapshot comparison metadata from');
                }
                return record.matches;
            });
        },
        restore: async (payload, expectedGeneration) => {
            return read('restore', JSON.stringify({ expectedGeneration, payload }), (record) => {
                const status = record.status;
                if (status !== 'restored' && status !== 'skipped-external-write') {
                    throw contentFreeNativeError('parse restore metadata from');
                }
                return {
                    generation: numericField(record, 'generation', 'restore'),
                    status,
                };
            });
        },
        snapshot: async () => {
            return read('snapshot', undefined, (record) => {
                if (typeof record.payload !== 'string' || record.payload.length === 0) {
                    throw contentFreeNativeError('parse snapshot metadata from');
                }
                return { ...metadata(record, 'snapshot'), payload: record.payload };
            });
        },
        writeFixture: async (fixture) => {
            return read(`write-${fixture}`, undefined, (record) =>
                metadata(record, 'fixture write'),
            );
        },
    };
}

const nativePasteboard = createClipboardNativeAdapter();

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
        } catch (error) {
            throw sanitizedClipboardFailure(error, 'Could not claim E2E image clipboard ownership');
        }
    }

    async claimText(expectedText: string): Promise<void> {
        if (this.restorePromise) throw new Error('The E2E clipboard restore is already finalized');
        try {
            this.ownedGeneration = await this.native.claimText(expectedText);
        } catch (error) {
            throw sanitizedClipboardFailure(error, 'Could not claim E2E text clipboard ownership');
        }
    }

    async matchesSnapshot(): Promise<boolean> {
        try {
            return await this.native.matchesSnapshot(this.record.payload);
        } catch (error) {
            throw sanitizedClipboardFailure(error, 'Could not compare the E2E clipboard snapshot');
        }
    }

    async restore(): Promise<ClipboardRestoreOutcome> {
        this.restorePromise ??= (async () => {
            try {
                const outcome = await this.native.restore(
                    this.record.payload,
                    this.ownedGeneration,
                );
                /**
                 * The native restore verifies the reconstructed payload before returning its generation receipt. A
                 * second helper invocation would race a later external write and misreport a successful restore.
                 */
                return outcome;
            } catch (error) {
                throw sanitizedClipboardFailure(error, 'Could not restore the E2E clipboard');
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
    } catch (error) {
        throw sanitizedClipboardFailure(error, 'Could not snapshot the E2E clipboard');
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
 * Binds native clipboard access to the protected snapshot owned by one declared E2E launch. Callers receive this narrow
 * capability instead of the raw Electron application, so aliases and indirect helpers cannot bypass pool classification
 * through `app.evaluate`. Text comparisons stay inside Electron so clipboard contents never cross into assertion
 * artifacts.
 */
export function createClipboardCapability(
    app: ElectronApplication,
    snapshot: ClipboardSnapshot,
): ClipboardCapability {
    return {
        claimImage: () => snapshot.claimImage(),
        claimText: (expectedText) => snapshot.claimText(expectedText),
        hasImage: () =>
            app.evaluate(async ({ clipboard }) => {
                const items = await clipboard.read();
                return items.some((item) => item.types.some((type) => type.startsWith('image/')));
            }),
        metadata: snapshot.metadata,
        refuseTextWrites: () =>
            app.evaluate(({ clipboard }) => {
                clipboard.writeText = () =>
                    Promise.reject(new Error('Clipboard write refused by the E2E fixture'));
            }),
        restoreOutcome: () => snapshot.restoreOutcome(),
        textEquals: (expectedText) =>
            app.evaluate(
                async ({ clipboard }, expected) => (await clipboard.readText()) === expected,
                expectedText,
            ),
        writePngBase64: async (value) => {
            await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, pngBase64) => {
                clipboard.clear();
                const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
                if (image.isEmpty()) throw new Error('Image clipboard fixture is empty');
                const imageBytes = Uint8Array.from(image.toPNG());
                await clipboard.write([
                    new ClipboardItem({
                        'image/png': new Blob([imageBytes], { type: 'image/png' }),
                    }),
                ]);
            }, value);
            await snapshot.claimImage();
        },
        writeText: async (value) => {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), value);
            await snapshot.claimText(value);
        },
    };
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
