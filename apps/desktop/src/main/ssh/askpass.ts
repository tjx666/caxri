import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { SshHostAskpassKind, SshHostAskpassRequest } from '@caxri/protocol';
import { ensurePrivateUnixSocketDirectory } from '@caxri/system';

import { shellQuote } from './shell-quote';

/**
 * One prompt line from the helper. OpenSSH prompts are short; the cap keeps a misbehaving client from buffering
 * unbounded memory in Main.
 */
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_PROMPT_LENGTH = 4000;

export type AskpassHandler = (
    request: SshHostAskpassRequest,
    signal: AbortSignal,
) => Promise<string | null>;

/**
 * Maps an OpenSSH prompt to the input it expects. Host-key questions need a literal `yes`/`no`; passwords, key
 * passphrases, and one-time codes are secrets that must not be echoed; anything else is shown as plain text input.
 */
export function classifyAskpassPrompt(prompt: string): SshHostAskpassKind {
    if (
        /are you sure you want to continue connecting/iu.test(prompt) ||
        /fingerprint/iu.test(prompt)
    )
        return 'confirm';
    if (/passphrase|password|verification code|one-time|\botp\b|pin for/iu.test(prompt))
        return 'secret';
    return 'text';
}

/**
 * Strips terminal control sequences from a prompt before it reaches the UI, keeping line breaks.
 */
function sanitizePrompt(prompt: string): string {
    return (
        prompt
            // eslint-disable-next-line no-control-regex -- removing control characters is the point
            .replaceAll(/[\u{0}-\u{9}\u{B}-\u{1F}\u{7F}]/gu, '')
            .slice(0, MAX_PROMPT_LENGTH)
    );
}

/**
 * CommonJS helper OpenSSH runs (through the shell wrapper) as `SSH_ASKPASS`. It forwards its prompt argument over the
 * private socket and prints the reply on stdout, which is how OpenSSH reads an askpass answer; any failure or a
 * cancellation exits non-zero so OpenSSH treats the prompt as refused. It must stay dependency-free because it runs as
 * plain Node inside the Electron binary.
 */
const ASKPASS_HELPER_SOURCE = String.raw`'use strict';
const net = require('node:net');
const socketPath = process.env.CAXRI_ASKPASS_SOCKET;
const token = process.env.CAXRI_ASKPASS_TOKEN;
if (!socketPath || !token) process.exit(1);
const prompt = process.argv.slice(2).join(' ');
let settled = false;
function finish(code, answer) {
    if (settled) return;
    settled = true;
    if (answer === undefined) process.exit(code);
    process.stdout.write(answer + '\n', () => process.exit(code));
}
const socket = net.createConnection(socketPath);
let buffer = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt }) + '\n'));
socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 65536) return finish(1);
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    let reply;
    try {
        reply = JSON.parse(buffer.slice(0, newline));
    } catch {
        return finish(1);
    }
    socket.end();
    if (reply && typeof reply.answer === 'string') finish(0, reply.answer);
    else finish(1);
});
socket.on('error', () => finish(1));
socket.on('close', () => finish(1));
`;

export interface AskpassBridgeOptions {
    /**
     * A short private directory (created 0700 and verified as owned by the current user); the bridge creates its own
     * subdirectory inside it. Its socket path must fit `sun_path`.
     */
    directory: string;
    /**
     * Desktop's own Electron binary (`process.execPath`), run with `ELECTRON_RUN_AS_NODE=1` so no separate Node is
     * needed. Tests pass a plain Node binary, which ignores that variable.
     */
    electronExecutable: string;
    /**
     * Shows the prompt and resolves with the answer, or `null` to refuse it. The caller owns logging (closed kind and
     * outcome only); the bridge never logs prompts or answers.
     */
    handler: AskpassHandler;
}

/**
 * Main-side endpoint for OpenSSH's `SSH_ASKPASS`. OpenSSH runs a fresh helper process for every prompt; each helper
 * proves it was written by this bridge with a random token baked into its 0700 wrapper script, so another local process
 * that finds the socket cannot inject prompts or read answers.
 */
export class AskpassBridge {
    static async create(options: AskpassBridgeOptions): Promise<AskpassBridge> {
        await ensurePrivateUnixSocketDirectory(options.directory);
        const directory = await mkdtemp(join(options.directory, 'a-'));
        await chmod(directory, 0o700);
        const token = randomBytes(32);
        const socketPath = join(directory, 's');
        const scriptPath = join(directory, 'askpass.cjs');
        const helperPath = join(directory, 'askpass');
        await writeFile(scriptPath, ASKPASS_HELPER_SOURCE, { mode: 0o600 });
        /**
         * The wrapper carries the socket and token instead of the `ssh` environment, so neither appears in the
         * environment of every `ssh` invocation. `NODE_OPTIONS` is cleared so a user's global Node flags cannot break
         * or instrument the helper.
         */
        const wrapper = [
            '#!/bin/sh',
            'unset NODE_OPTIONS',
            `CAXRI_ASKPASS_SOCKET=${shellQuote(socketPath)}`,
            `CAXRI_ASKPASS_TOKEN=${shellQuote(token.toString('hex'))}`,
            'ELECTRON_RUN_AS_NODE=1',
            'export CAXRI_ASKPASS_SOCKET CAXRI_ASKPASS_TOKEN ELECTRON_RUN_AS_NODE',
            `exec ${shellQuote(options.electronExecutable)} ${shellQuote(scriptPath)} "$@"`,
            '',
        ].join('\n');
        await writeFile(helperPath, wrapper, { mode: 0o700 });
        await chmod(helperPath, 0o700);
        const server = createServer();
        const bridge = new AskpassBridge(server, token, directory, helperPath, options);
        server.on('connection', (socket) => bridge.handleConnection(socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });
        await chmod(socketPath, 0o600);
        return bridge;
    }

    private readonly pending = new Set<AbortController>();
    /**
     * Answers given per secret prompt in the current connection attempt; see `beginAttempt`.
     */
    private readonly answeredSecrets = new Map<string, number>();
    /**
     * Set once the user cancels a prompt in the current connection attempt; see `beginAttempt`.
     */
    private isAttemptCancelled = false;
    private isClosed = false;

    private constructor(
        private readonly server: Server,
        private readonly token: Buffer,
        readonly directory: string,
        readonly helperPath: string,
        private readonly options: AskpassBridgeOptions,
    ) {}

    private handleConnection(socket: Socket): void {
        let buffer = Buffer.alloc(0);
        let isHandled = false;
        socket.on('error', () => socket.destroy());
        socket.on('data', (chunk: Buffer) => {
            if (isHandled) return;
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > MAX_REQUEST_BYTES) {
                socket.destroy();
                return;
            }
            const newline = buffer.indexOf(0x0a);
            if (newline === -1) return;
            isHandled = true;
            // eslint-disable-next-line no-void -- failures are answered on the socket inside `respond`.
            void this.respond(socket, buffer.subarray(0, newline).toString('utf8'));
        });
    }

    private async respond(socket: Socket, line: string): Promise<void> {
        let prompt: string;
        try {
            const message = JSON.parse(line) as unknown;
            const token: unknown =
                typeof message === 'object' && message !== null
                    ? Reflect.get(message, 'token')
                    : undefined;
            const rawPrompt: unknown =
                typeof message === 'object' && message !== null
                    ? Reflect.get(message, 'prompt')
                    : undefined;
            if (typeof token !== 'string' || typeof rawPrompt !== 'string')
                throw new Error('shape');
            const received = Buffer.from(token, 'hex');
            if (received.length !== this.token.length || !timingSafeEqual(received, this.token))
                throw new Error('token');
            prompt = sanitizePrompt(rawPrompt);
        } catch {
            socket.destroy();
            return;
        }
        /**
         * OpenSSH treats a refused prompt as one failed try and asks again (a password up to `NumberOfPasswordPrompts`
         * times, then the next authentication method), so after a cancel the rest of the attempt is refused unseen and
         * Cancel stops the connection at once.
         */
        if (this.isClosed || this.isAttemptCancelled) {
            socket.end(`${JSON.stringify({ answer: null })}\n`);
            return;
        }
        const controller = new AbortController();
        this.pending.add(controller);
        /**
         * The helper dies with its `ssh` process; abort lets the UI dismiss a prompt nobody is waiting for anymore.
         */
        const abort = (): void => controller.abort();
        socket.once('close', abort);
        const kind = classifyAskpassPrompt(prompt);
        const retry = kind === 'secret' ? (this.answeredSecrets.get(prompt) ?? 0) : 0;
        let answer: string | null;
        try {
            answer = await this.options.handler(
                { requestId: randomUUID(), kind, prompt, ...(retry > 0 && { retry }) },
                controller.signal,
            );
        } catch {
            answer = null;
        } finally {
            this.pending.delete(controller);
            socket.off('close', abort);
        }
        if (socket.destroyed) return;
        const delivered = controller.signal.aborted ? null : answer;
        if (answer === null && !controller.signal.aborted) this.isAttemptCancelled = true;
        if (kind === 'secret' && delivered !== null) this.answeredSecrets.set(prompt, retry + 1);
        socket.end(`${JSON.stringify({ answer: delivered })}\n`);
    }

    /**
     * Starts a new `ssh` connection attempt: repeated secret prompts are counted afresh and a previous cancel no longer
     * refuses prompts. Within one attempt OpenSSH repeats a passphrase or password prompt only after rejecting the
     * answer, so a repeat is reported as a retry; a later reconnect asking the same prompt is a first ask again.
     */
    beginAttempt(): void {
        this.answeredSecrets.clear();
        this.isAttemptCancelled = false;
    }

    /**
     * Variables that make OpenSSH use this bridge for every prompt, even when a terminal is attached. `DISPLAY` must be
     * set for OpenSSH releases that only consult `SSH_ASKPASS` when an X display is present.
     */
    environment(): Record<string, string> {
        return {
            DISPLAY: 'caxri',
            SSH_ASKPASS: this.helperPath,
            SSH_ASKPASS_REQUIRE: 'force',
        };
    }

    async close(): Promise<void> {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const controller of this.pending) controller.abort();
        this.pending.clear();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        await rm(this.directory, { force: true, recursive: true });
    }
}
