#!/usr/bin/env bun

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isOwnedRuntime, runtimeStateSchema } from './runtime-state';

interface CdpTarget {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

interface FrameOptions {
    command: 'frames';
    count: number;
    intervalMs: number;
    outDir: string;
    port?: number;
    urlContains?: string;
}

interface DomOptions {
    command: 'dom';
    output: string;
    port?: number;
    selector: string;
    urlContains?: string;
}

export type CaptureOptions = DomOptions | FrameOptions;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const MAX_FRAME_COUNT = 600;
const MAX_INTERVAL_MS = 60_000;
const CDP_TIMEOUT_MS = 10_000;
const HELP = `Capture the owned isolated Caxri Renderer through CDP.

Usage:
  capture-renderer.ts frames --out-dir DIR [--port PORT] [--url-contains TEXT] [--count 40] [--interval-ms 250]
  capture-renderer.ts dom --output FILE --selector SELECTOR [--port PORT] [--url-contains TEXT]
`;

function requiredValue(args: string[], index: number, option: string): string {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function boundedPositiveInteger(raw: string, option: string, maximum: number): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${option} must be an integer between 1 and ${maximum}`);
    }
    return value;
}

export function parseCaptureOptions(args: string[]): CaptureOptions | 'help' {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) return 'help';

    const command = args[0];
    if (command !== 'dom' && command !== 'frames') {
        throw new Error(`Unknown command: ${command}`);
    }

    const values = new Map<string, string>();
    const allowedOptions =
        command === 'dom'
            ? new Set(['--output', '--port', '--selector', '--url-contains'])
            : new Set(['--count', '--interval-ms', '--out-dir', '--port', '--url-contains']);
    for (let index = 1; index < args.length; index += 2) {
        const option = args[index];
        if (!option?.startsWith('--')) throw new Error(`Unexpected argument: ${option}`);
        if (!allowedOptions.has(option)) throw new Error(`Unknown option: ${option}`);
        values.set(option, requiredValue(args, index, option));
    }

    const rawPort = values.get('--port');
    const port = rawPort ? boundedPositiveInteger(rawPort, '--port', 65_535) : undefined;
    const urlContains = values.get('--url-contains');

    if (command === 'dom') {
        const output = values.get('--output');
        const selector = values.get('--selector');
        if (!output) throw new Error('--output is required');
        if (!selector) throw new Error('--selector is required');
        return { command, output: resolve(output), port, selector, urlContains };
    }

    const outDir = values.get('--out-dir');
    if (!outDir) throw new Error('--out-dir is required');
    return {
        command,
        count: boundedPositiveInteger(values.get('--count') ?? '40', '--count', MAX_FRAME_COUNT),
        intervalMs: boundedPositiveInteger(
            values.get('--interval-ms') ?? '250',
            '--interval-ms',
            MAX_INTERVAL_MS,
        ),
        outDir: resolve(outDir),
        port,
        urlContains,
    };
}

export function selectRendererTarget(targets: CdpTarget[], urlContains?: string): CdpTarget {
    const pages = targets.filter(
        (target) =>
            target.type === 'page' &&
            Boolean(target.webSocketDebuggerUrl) &&
            !target.url.startsWith('devtools://'),
    );
    const mainRendererPages = pages.filter((target) =>
        /\/out\/renderer\/index\.html(?:[?#]|$)/.test(target.url),
    );
    const rendererPages = pages.filter((target) => target.url.includes('/out/renderer/'));
    const candidates = urlContains
        ? pages.filter((target) => target.url.includes(urlContains))
        : mainRendererPages.length > 0
          ? mainRendererPages
          : rendererPages.length > 0
            ? rendererPages
            : pages;
    if (candidates.length !== 1) {
        const urls = pages.map((target) => target.url).join(', ') || 'none';
        const selector = urlContains ? ` matching "${urlContains}"` : '';
        throw new Error(
            `Expected exactly one Caxri Renderer CDP target${selector}; available: ${urls}`,
        );
    }
    return candidates[0];
}

export function resolveOwnedCapturePort(runtimePort: number, requestedPort?: number): number {
    if (requestedPort !== undefined && requestedPort !== runtimePort) {
        throw new Error(
            `Requested CDP port ${requestedPort} does not match owned Acceptance port ${runtimePort}`,
        );
    }
    return runtimePort;
}

class CdpClient {
    private nextId = 1;
    private readonly pending = new Map<
        number,
        { reject: (error: Error) => void; resolve: (value: unknown) => void }
    >();

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data)) as {
                error?: { message: string };
                id?: number;
                result?: unknown;
            };
            if (message.id === undefined) return;
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
        });
        socket.addEventListener('close', () => {
            for (const request of this.pending.values()) {
                request.reject(new Error('CDP connection closed'));
            }
            this.pending.clear();
        });
    }

    static async connect(url: string): Promise<CdpClient> {
        const socket = new WebSocket(url);
        await new Promise<void>((resolveOpen, rejectOpen) => {
            const cleanup = (): void => {
                clearTimeout(timeout);
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
            };
            const onOpen = (): void => {
                cleanup();
                resolveOpen();
            };
            const onError = (): void => {
                cleanup();
                rejectOpen(new Error(`Unable to connect to ${url}`));
            };
            const timeout = setTimeout(() => {
                cleanup();
                socket.close();
                rejectOpen(new Error(`Timed out connecting to ${url}`));
            }, CDP_TIMEOUT_MS);
            socket.addEventListener('open', onOpen, { once: true });
            socket.addEventListener('error', onError, { once: true });
        });
        return new CdpClient(socket);
    }

    close(): void {
        this.socket.close();
    }

    async request<T>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs = CDP_TIMEOUT_MS,
    ): Promise<T> {
        const id = this.nextId++;
        const result = new Promise<unknown>((resolveRequest, rejectRequest) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                rejectRequest(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                reject: (error) => {
                    clearTimeout(timeout);
                    rejectRequest(error);
                },
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolveRequest(value);
                },
            });
        });
        this.socket.send(JSON.stringify({ id, method, params }));
        return (await result) as T;
    }
}

async function connect(port: number, urlContains?: string): Promise<CdpClient> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
    const target = selectRendererTarget((await response.json()) as CdpTarget[], urlContains);
    if (!target.webSocketDebuggerUrl) throw new Error('Renderer target has no WebSocket URL');
    return CdpClient.connect(target.webSocketDebuggerUrl);
}

async function captureFrames(options: FrameOptions, port: number): Promise<void> {
    await mkdir(options.outDir, { recursive: true });
    const existingFrames = (await readdir(options.outDir)).filter((name) =>
        /^frame_\d+\.png$/.test(name),
    );
    if (existingFrames.length > 0) {
        throw new Error(`Frame directory already contains captures: ${options.outDir}`);
    }

    const client = await connect(port, options.urlContains);
    try {
        await client.request('Page.enable');
        await client.request('Page.bringToFront');
        const startedAt = Date.now();
        for (let index = 0; index < options.count; index += 1) {
            let result: { data: string };
            try {
                result = await client.request<{ data: string }>(
                    'Page.captureScreenshot',
                    {
                        captureBeyondViewport: false,
                        format: 'png',
                        fromSurface: true,
                    },
                    Math.max(5_000, options.intervalMs * 4),
                );
            } catch (error: unknown) {
                throw new Error(`Renderer frame ${index + 1} of ${options.count} failed`, {
                    cause: error,
                });
            }
            const path = resolve(options.outDir, `frame_${String(index).padStart(6, '0')}.png`);
            await writeFile(path, Buffer.from(result.data, 'base64'));

            const remaining = startedAt + (index + 1) * options.intervalMs - Date.now();
            if (remaining > 0 && index + 1 < options.count) {
                await new Promise<void>((resolveWait) => setTimeout(resolveWait, remaining));
            }
        }
    } finally {
        client.close();
    }
    console.log(`Captured ${options.count} Renderer frames in ${options.outDir}`);
}

async function captureDom(options: DomOptions, port: number): Promise<void> {
    const client = await connect(port, options.urlContains);
    try {
        const expression = `(() => {
            const node = document.querySelector(${JSON.stringify(options.selector)});
            return node ? new XMLSerializer().serializeToString(node) : null;
        })()`;
        const evaluation = await client.request<{
            exceptionDetails?: { text: string };
            result: { value?: string | null };
        }>('Runtime.evaluate', { expression, returnByValue: true });
        if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
        if (!evaluation.result.value) {
            throw new Error(`Renderer selector was not found: ${options.selector}`);
        }
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, evaluation.result.value, 'utf8');
    } finally {
        client.close();
    }
    console.log(`Captured Renderer DOM snapshot at ${options.output}`);
}

async function main(): Promise<void> {
    const options = parseCaptureOptions(process.argv.slice(2));
    if (options === 'help') {
        console.log(HELP);
        return;
    }
    const runtime = runtimeStateSchema.parse(JSON.parse(await readFile(RUNTIME_PATH, 'utf8')));
    if (!(await isOwnedRuntime(runtime))) {
        throw new Error('Acceptance runtime state does not belong to a live owned process');
    }
    const port = resolveOwnedCapturePort(runtime.port, options.port);
    if (options.command === 'frames') await captureFrames(options, port);
    else await captureDom(options, port);
}

if (import.meta.main) {
    void main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
