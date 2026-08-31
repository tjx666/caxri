import { Buffer } from 'node:buffer';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { TerminalFixturePreflightReceipt } from './fixture-preflight';
import {
    createTerminalFixturePreflightReceipt,
    terminalFixturePreflightReceiptSchema,
} from './fixture-preflight';
import type { RuntimeState } from './runtime-state';
import { isOwnedRuntime, runtimeStateSchema } from './runtime-state';

interface CdpTarget {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

interface FrameOptions {
    command: 'frames';
    count: number;
    fixturePreflight?: string;
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

interface ScreenshotOptions {
    command: 'screenshot';
    output: string;
    port?: number;
    urlContains?: string;
}

export type CaptureOptions = DomOptions | FrameOptions | ScreenshotOptions;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const MAX_FRAME_COUNT = 600;
const MAX_INTERVAL_MS = 60_000;
const CDP_TIMEOUT_MS = 10_000;
const HELP = `Capture the owned isolated Caxri Renderer through CDP.

Usage:
  capture-renderer.ts frames --out-dir DIR [--fixture-preflight FIXTURE_JSON] [--port PORT] [--url-contains TEXT] [--count 40] [--interval-ms 250]
  capture-renderer.ts dom --output FILE --selector SELECTOR [--port PORT] [--url-contains TEXT]
  capture-renderer.ts screenshot --output FILE [--port PORT] [--url-contains TEXT]
`;

function requiredValue(arguments_: string[], index: number, option: string): string {
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function boundedPositiveInteger(raw: string, option: string, maximum: number): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${option} must be an integer between 1 and ${maximum}`);
    }
    return value;
}

export function parseCaptureOptions(arguments_: string[]): CaptureOptions | 'help' {
    if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h'))
        return 'help';

    const command = arguments_[0];
    if (command !== 'dom' && command !== 'frames' && command !== 'screenshot') {
        throw new Error(`Unknown command: ${command}`);
    }

    const values = new Map<string, string>();
    const allowedOptions =
        command === 'dom'
            ? new Set(['--output', '--port', '--selector', '--url-contains'])
            : command === 'screenshot'
              ? new Set(['--output', '--port', '--url-contains'])
              : new Set([
                    '--count',
                    '--fixture-preflight',
                    '--interval-ms',
                    '--out-dir',
                    '--port',
                    '--url-contains',
                ]);
    for (let index = 1; index < arguments_.length; index += 2) {
        // `index < arguments_.length` (loop condition) guarantees `option` is in bounds.
        const option = arguments_[index];
        if (!option.startsWith('--')) {
            const guidance =
                command === 'screenshot' ? '; pass the screenshot path with --output <file>' : '';
            throw new Error(`Unexpected argument: ${option}${guidance}`);
        }
        if (!allowedOptions.has(option)) throw new Error(`Unknown option: ${option}`);
        values.set(option, requiredValue(arguments_, index, option));
    }

    const rawPort = values.get('--port');
    const port = rawPort ? boundedPositiveInteger(rawPort, '--port', 65_535) : undefined;
    const urlContains = values.get('--url-contains');

    if (command === 'dom') {
        const output = values.get('--output');
        if (!output) throw new Error('--output is required');
        const selector = values.get('--selector');
        if (!selector) throw new Error('--selector is required');
        return { command, output: resolve(output), port, selector, urlContains };
    }

    if (command === 'screenshot') {
        const output = values.get('--output');
        if (!output) throw new Error('--output is required');
        if (!output.toLowerCase().endsWith('.png')) {
            throw new Error('--output must use a .png extension');
        }
        return { command, output: resolve(output), port, urlContains };
    }

    const outputDirectory = values.get('--out-dir');
    if (!outputDirectory) throw new Error('--out-dir is required');
    const fixturePreflight = values.get('--fixture-preflight');
    return {
        command,
        count: boundedPositiveInteger(values.get('--count') ?? '40', '--count', MAX_FRAME_COUNT),
        fixturePreflight: fixturePreflight ? resolve(fixturePreflight) : undefined,
        intervalMs: boundedPositiveInteger(
            values.get('--interval-ms') ?? '250',
            '--interval-ms',
            MAX_INTERVAL_MS,
        ),
        outDir: resolve(outputDirectory),
        port,
        urlContains,
    };
}

export async function requireCapturePreflight(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Fixture preflight input must be a direct regular file');
    }
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const receipt: TerminalFixturePreflightReceipt =
        terminalFixturePreflightReceiptSchema.parse(raw);
    const verified = createTerminalFixturePreflightReceipt(receipt.fixture, receipt.caseId);
    if (JSON.stringify(receipt) !== JSON.stringify(verified)) {
        throw new Error('Fixture preflight receipt does not match its observed fixture');
    }
    if (receipt.result.status !== 'ready') {
        throw new Error(
            `Frame capture blocked by fixture preflight: ${receipt.result.errors.map(({ code }) => code).join(', ')}`,
        );
    }
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

export function requiresRuntimeTerminalFixturePreflight(
    acceptanceCase: RuntimeState['acceptanceCase'],
): boolean {
    return acceptanceCase?.requiresTerminalFixturePreflight !== false;
}

class CdpClient {
    static async connect(url: string): Promise<CdpClient> {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                socket.close();
                reject(new Error(`Timed out connecting to ${url}`));
            }, CDP_TIMEOUT_MS);

            function cleanup(): void {
                clearTimeout(timeout);
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
            }

            function onOpen(): void {
                cleanup();
                resolve();
            }

            function onError(): void {
                cleanup();
                reject(new Error(`Unable to connect to ${url}`));
            }

            socket.addEventListener('open', onOpen, { once: true });
            socket.addEventListener('error', onError, { once: true });
        });
        return new CdpClient(socket);
    }

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

    close(): void {
        this.socket.close();
    }

    async request<T>(
        method: string,
        parameters: Record<string, unknown> = {},
        timeoutMs = CDP_TIMEOUT_MS,
    ): Promise<T> {
        const id = this.nextId++;
        const result = new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
            });
        });
        this.socket.send(JSON.stringify({ id, method, params: parameters }));
        return (await result) as T;
    }
}

interface CaptureClient {
    close(): void;
    request<T>(
        method: string,
        parameters?: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<T>;
}

type CaptureConnector = (port: number, urlContains?: string) => Promise<CaptureClient>;

async function connect(port: number, urlContains?: string): Promise<CdpClient> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
    const target = selectRendererTarget((await response.json()) as CdpTarget[], urlContains);
    if (!target.webSocketDebuggerUrl) throw new Error('Renderer target has no WebSocket URL');
    return CdpClient.connect(target.webSocketDebuggerUrl);
}

export async function captureFrames(
    options: FrameOptions,
    port: number,
    connectClient: CaptureConnector = connect,
    requiresTerminalFixturePreflight = true,
): Promise<void> {
    if (requiresTerminalFixturePreflight && !options.fixturePreflight) {
        throw new Error('--fixture-preflight is required for a terminal fixture frame capture');
    }
    if (options.fixturePreflight) await requireCapturePreflight(options.fixturePreflight);
    await mkdir(options.outDir, { recursive: true });
    const existingFrames = (await readdir(options.outDir)).filter((name) =>
        /^frame_\d+\.png$/.test(name),
    );
    if (existingFrames.length > 0) {
        throw new Error(`Frame directory already contains captures: ${options.outDir}`);
    }

    const client = await connectClient(port, options.urlContains);
    try {
        await client.request('Page.enable');
        const startedAt = Date.now();
        // Frames are captured one at a time over a single CDP connection and paced by
        // `intervalMs`; each iteration must await the previous capture and its pacing delay
        // before requesting the next frame, so the awaits below are intentionally sequential.
        for (let index = 0; index < options.count; index += 1) {
            let result: { data: string };
            try {
                // eslint-disable-next-line no-await-in-loop
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
            // eslint-disable-next-line no-await-in-loop
            await writeFile(path, Buffer.from(result.data, 'base64'));

            const remaining = startedAt + (index + 1) * options.intervalMs - Date.now();
            if (remaining > 0 && index + 1 < options.count) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise<void>((resolve) => setTimeout(resolve, remaining));
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

export async function captureScreenshot(
    options: ScreenshotOptions,
    port: number,
    connectClient: CaptureConnector = connect,
): Promise<void> {
    const client = await connectClient(port, options.urlContains);
    try {
        await client.request('Page.enable');
        const result = await client.request<{ data: string }>('Page.captureScreenshot', {
            captureBeyondViewport: false,
            format: 'png',
            fromSurface: true,
        });
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, Buffer.from(result.data, 'base64'));
    } finally {
        client.close();
    }
    console.log(`Captured Renderer screenshot at ${options.output}`);
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
    if (options.command === 'frames') {
        /**
         * Old or unscoped runtime receipts fail closed. Only a launcher that read the frozen case plan may explicitly
         * prove that this temporal claim does not use a Terminal fixture and therefore needs no grid preflight.
         */
        const requiresTerminalFixturePreflight = requiresRuntimeTerminalFixturePreflight(
            runtime.acceptanceCase,
        );
        await captureFrames(options, port, connect, requiresTerminalFixturePreflight);
    } else if (options.command === 'dom') await captureDom(options, port);
    else await captureScreenshot(options, port);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
