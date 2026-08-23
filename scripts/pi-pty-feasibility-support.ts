import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export const piSpikeBaseline = {
    archiveSha256DarwinArm64: 'c996e888b7f7dce44bcf24f69176ac646c44139d3916bd49a6b28e5a8c5e3a65',
    commit: '914cf1472e715297caa30db4b9535d534a9eb718',
    executableSha256DarwinArm64: 'd5de3fe32f9e109324f32d6e393554fb2ce10bbc82e8ff935ab2e072f5e2f044',
    license: 'MIT',
    package: '@earendil-works/pi-coding-agent',
    version: '0.84.2',
} as const;

export const piSpikeRequiredHelpFlags = [
    '--session <path|id>',
    '--session-id <id>',
    '--session-dir <dir>',
    '--version, -v',
    '--extension, -e <path>',
    '--no-extensions, -ne',
    '--skill <path>',
    '--no-skills, -ns',
    '--approve, -a',
    '--no-approve, -na',
    '--offline',
] as const;

export interface PiSpikeLaunch {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    executable: string;
}

export interface PiSpikeLaunchOptions {
    endpoint: string;
    eventsPath: string;
    extensionPath: string;
    piBin: string;
    root: string;
    sessionId: string;
}

export interface PiSpikeModelServer {
    close(): Promise<void>;
    endpoint: string;
    requestCount(): number;
}

export interface VerifiedPiSpikeExecutable {
    path: string;
    sha256: string;
}

/**
 * Models Pi's no-index production contract without registering a production provider. A future descriptor must keep
 * this result until Pi publishes a standalone metadata index that does not require persisted-session inspection.
 */
export function readPiSpikeState(): Promise<undefined> {
    return Promise.resolve(undefined);
}

/**
 * Resolves the executable into a Caxri-named operating-system temporary directory and verifies its official release
 * digest. Returning the canonical path prevents an accepted symlink from redirecting a later launch outside the
 * reviewed isolated acquisition root.
 */
export async function verifyPiSpikeExecutable(path: string): Promise<VerifiedPiSpikeExecutable> {
    if (!isAbsolute(path)) throw new Error(`Pi spike executable must be absolute: ${path}`);
    const resolvedPath = await realpath(path);
    const temporaryRoots = await Promise.all(
        [...new Set([tmpdir(), '/tmp'])].map((root) => realpath(root)),
    );
    const isIsolatedTemporaryPath = temporaryRoots.some((temporaryRoot) => {
        const suffix = relative(temporaryRoot, resolvedPath);
        if (
            suffix === '' ||
            suffix === '..' ||
            suffix.startsWith(`..${sep}`) ||
            isAbsolute(suffix)
        ) {
            return false;
        }
        return suffix.split(sep)[0]?.startsWith('caxri-pi-') === true;
    });
    if (!isIsolatedTemporaryPath) {
        throw new Error(
            `Pi spike executable must resolve inside a Caxri-owned operating-system temporary directory: ${resolvedPath}`,
        );
    }
    const hash = createHash('sha256');

    for await (const chunk of createReadStream(resolvedPath)) hash.update(chunk as Buffer);
    const digest = hash.digest('hex');
    if (digest !== piSpikeBaseline.executableSha256DarwinArm64) {
        throw new Error(
            `Expected official Pi macOS arm64 executable SHA-256 ${piSpikeBaseline.executableSha256DarwinArm64}, received ${digest}`,
        );
    }
    return { path: resolvedPath, sha256: digest };
}

export interface PiSpikeLifecycleEvent {
    detail: string;
    kind: string;
    sessionId: string;
}

export function selectPiSpikeLifecycleEvent(
    events: readonly PiSpikeLifecycleEvent[],
    isMatch: (event: PiSpikeLifecycleEvent) => boolean,
    minimumMatches = 1,
): PiSpikeLifecycleEvent | undefined {
    const matches = events.filter(isMatch);
    return matches.length >= minimumMatches ? matches.at(-1) : undefined;
}

/**
 * Pi v0.84.2 accepts alphanumeric IDs with `-`, `_`, and `.` inside, while requiring an alphanumeric first and last
 * character. Matching the official validator keeps the spike from proving a looser identity contract than Pi actually
 * supports.
 */
export function isValidPiSessionId(value: string): boolean {
    return /^[a-z\d](?:[\w.-]*[a-z\d])?$/i.test(value);
}

export function createPiSpikeSessionId(uuid: string): string {
    const sessionId = `caxri-${uuid}`;
    if (!isValidPiSessionId(sessionId))
        throw new Error(`Invalid Caxri Pi session id: ${sessionId}`);
    return sessionId;
}

/**
 * Creates the complete environment visible to the official Pi process. It is deliberately an allowlist instead of a
 * clone of `process.env`, so a local account, credential, proxy, or real Pi configuration can never become accidental
 * spike authority.
 */
export function createPiSpikeEnvironment(options: {
    endpoint: string;
    eventsPath: string;
    root: string;
}): NodeJS.ProcessEnv {
    return {
        CAXRI_PI_SPIKE_ENDPOINT: options.endpoint,
        CAXRI_PI_SPIKE_EVENTS: options.eventsPath,
        COLORTERM: 'truecolor',
        HOME: join(options.root, 'home'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LOGNAME: 'caxri-pi-spike',
        NO_PROXY: '127.0.0.1,localhost',
        PATH: '/usr/bin:/bin',
        PI_CODING_AGENT_DIR: join(options.root, 'config'),
        PI_CODING_AGENT_SESSION_DIR: join(options.root, 'sessions'),
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        SHELL: '/bin/zsh',
        TERM: 'xterm-256color',
        TMPDIR: join(options.root, 'tmp'),
        USER: 'caxri-pi-spike',
    };
}

/**
 * Produces the exact standalone PTY launch investigated by issue #148. Every argument stays a separate array element,
 * and every writable Pi path stays below the caller's temporary root.
 */
export function createPiSpikeLaunch(options: PiSpikeLaunchOptions): PiSpikeLaunch {
    for (const [label, path] of [
        ['Pi executable', options.piBin],
        ['events path', options.eventsPath],
        ['extension path', options.extensionPath],
        ['temporary root', options.root],
    ] as const) {
        if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
    }
    if (!isValidPiSessionId(options.sessionId)) {
        throw new Error(`Invalid Pi session id: ${options.sessionId}`);
    }
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
        throw new Error(`Pi spike endpoint must use isolated loopback HTTP: ${options.endpoint}`);
    }
    for (const [label, path] of [
        ['events path', options.eventsPath],
        ['extension path', options.extensionPath],
    ] as const) {
        const suffix = relative(options.root, path);
        if (
            suffix === '' ||
            suffix === '..' ||
            suffix.startsWith(`..${sep}`) ||
            isAbsolute(suffix)
        ) {
            throw new Error(`${label} must stay inside the temporary root: ${path}`);
        }
    }

    return {
        executable: options.piBin,
        args: [
            '--offline',
            '--no-approve',
            '--no-extensions',
            '--extension',
            options.extensionPath,
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-context-files',
            '--provider',
            'caxri-spike',
            '--model',
            'caxri-spike/deterministic',
            '--session-id',
            options.sessionId,
            '--session-dir',
            join(options.root, 'sessions'),
        ],
        cwd: join(options.root, 'project'),
        env: createPiSpikeEnvironment(options),
    };
}

/**
 * This extension observes only Pi's documented lifecycle hook arguments and the in-memory session identity exposed by
 * the extension API. It never enumerates or opens Pi's persisted session files.
 */
export function createPiSpikeExtensionSource(): string {
    return String.raw`import { appendFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const eventsPath = process.env.CAXRI_PI_SPIKE_EVENTS;
const endpoint = process.env.CAXRI_PI_SPIKE_ENDPOINT;
if (!eventsPath || !endpoint) throw new Error("Missing Caxri Pi spike isolation variables");

function safeField(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

async function record(kind: string, detail: string, ctx: ExtensionContext): Promise<void> {
  const fields = [kind, detail, ctx.sessionManager.getSessionId()].map(safeField);
  await appendFile(eventsPath, fields.join("\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("caxri-spike", {
    name: "Caxri deterministic spike",
    baseUrl: endpoint,
    apiKey: "local-spike-not-a-secret",
    api: "openai-completions",
    models: [{
      id: "deterministic",
      name: "Deterministic local spike",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 128,
    }],
  });

  pi.on("session_start", (event, ctx) => record("session_start", event.reason, ctx));
  pi.on("session_shutdown", (event, ctx) => record("session_shutdown", event.reason, ctx));
  pi.on("before_agent_start", (_event, ctx) => record("before_agent_start", "observed", ctx));
  pi.on("agent_end", (_event, ctx) => record("agent_end", "observed", ctx));
  pi.registerCommand("caxri-exit", {
    description: "Exit the isolated Caxri feasibility run",
    handler: async (_args, ctx) => {
      await record("command", "exit", ctx);
      ctx.shutdown();
    },
  });
}
`;
}

/**
 * Creates an E2E-only executable that replaces itself with the official Pi binary. `execve` keeps Pi as the PTY
 * foreground process and supplies a complete structured argv/environment without a shell or inherited developer state.
 */
export function createPiSpikeExecutableSource(
    launch: PiSpikeLaunch,
    options: { invocationReceiptPath: string },
): string {
    if (!isAbsolute(options.invocationReceiptPath)) {
        throw new Error('Pi invocation receipt path must be absolute');
    }
    const receiptSuffix = relative(dirname(launch.cwd), options.invocationReceiptPath);
    if (
        receiptSuffix === '' ||
        receiptSuffix === '..' ||
        receiptSuffix.startsWith(`..${sep}`) ||
        isAbsolute(receiptSuffix)
    ) {
        throw new Error('Pi invocation receipt path must stay inside the temporary root');
    }
    const sessionIdIndex = launch.args.indexOf('--session-id') + 1;
    const expectedSessionId = launch.args[sessionIdIndex];
    if (!expectedSessionId || !isValidPiSessionId(expectedSessionId)) {
        throw new Error('Pi launch is missing its caller-owned session id');
    }
    return `#!${process.execPath}\n${[
        'const { appendFileSync } = require("node:fs");',
        `process.chdir(${JSON.stringify(launch.cwd)});`,
        `const executable = ${JSON.stringify(launch.executable)};`,
        `const args = ${JSON.stringify(launch.args)};`,
        `const environment = ${JSON.stringify(launch.env)};`,
        `const receiptPath = ${JSON.stringify(options.invocationReceiptPath)};`,
        `const expectedSessionId = ${JSON.stringify(expectedSessionId)};`,
        `const sessionIdIndex = ${sessionIdIndex};`,
        'const incoming = process.argv.slice(2);',
        'if (incoming.length === 1 && incoming[0] === "--version") {',
        '  process.execve(executable, [executable, "--version"], environment);',
        '}',
        'let invocation = "create";',
        'let sessionId = expectedSessionId;',
        'if (incoming.length > 0) {',
        '  if (incoming.length !== 2 || incoming[0] !== "resume" || incoming[1] !== expectedSessionId) {',
        '    throw new Error("Caxri supplied an unexpected Pi resume identity");',
        '  }',
        '  invocation = "resume";',
        '  sessionId = incoming[1];',
        '}',
        'args[sessionIdIndex] = sessionId;',
        'appendFileSync(receiptPath, `${invocation}\\t${sessionId}\\n`, "utf8");',
        'process.execve(executable, [executable, ...args], environment);',
    ].join('\n')}\n`;
}

/**
 * Runs a deterministic localhost OpenAI-compatible response so Pi can persist and resume a real session without an
 * account, network access, or credential. The server consumes but never records request bodies; this proves CLI
 * lifecycle only and is not evidence of a real model invocation.
 */
export async function startPiSpikeModelServer(
    options: { responseDelayMs?: number } = {},
): Promise<PiSpikeModelServer> {
    const responseDelayMs = options.responseDelayMs ?? 0;
    if (!Number.isSafeInteger(responseDelayMs) || responseDelayMs < 0 || responseDelayMs > 5_000) {
        throw new RangeError('Pi spike response delay must be an integer from 0 to 5000ms');
    }
    let requests = 0;
    const server = createServer(async (request, response) => {
        for await (const chunk of request as AsyncIterable<Uint8Array>) {
            // Consume the fixed local request without inspecting or retaining it.
            if (chunk.length === 0) continue;
        }
        requests += 1;
        if (request.method !== 'POST') {
            response.writeHead(405).end();
            return;
        }
        if (responseDelayMs > 0) await delay(responseDelayMs);
        if (response.destroyed) return;
        response.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Connection': 'close',
            'Content-Type': 'text/event-stream',
        });
        const chunks = [
            {
                choices: [
                    {
                        delta: { content: 'CAXRI_PI_MODEL_OK', role: 'assistant' },
                        finish_reason: null,
                        index: 0,
                    },
                ],
                created: 0,
                id: 'caxri-pi-spike',
                model: 'deterministic',
                object: 'chat.completion.chunk',
            },
            {
                choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
                created: 0,
                id: 'caxri-pi-spike',
                model: 'deterministic',
                object: 'chat.completion.chunk',
                usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
            },
        ];
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        requestCount: () => requests,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
