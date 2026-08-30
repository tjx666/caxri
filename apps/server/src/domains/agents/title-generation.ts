import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';

import { CaxriError, sessionRenameTitleSchema } from '@caxri/protocol';

import { runExternalCommand } from '../executables';
import type { AgentTitleSource } from './contract';
import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript } from './transcript-security';

const MAX_TITLE_CHARACTERS = 60;
const MAX_TITLE_MESSAGE_CHARACTERS = 400;
const TITLE_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const TITLE_TRANSCRIPT_TAIL_BYTES = 768 * 1024;
const TITLE_COMMAND_OUTPUT_BYTES = 128 * 1024;
const TITLE_COMMAND_TIMEOUT_MS = 60_000;
const TITLE_COMMAND_TERMINATION_GRACE_MS = 1_000;

export interface AgentTitleMessage {
    role: 'assistant' | 'user';
    text: string;
}

function completeHead(source: string): string {
    const newline = source.lastIndexOf('\n');
    return newline === -1 ? '' : source.slice(0, newline + 1);
}

function completeTail(source: string): string {
    const newline = source.indexOf('\n');
    return newline === -1 ? '' : source.slice(newline + 1);
}

async function readRange(handle: FileHandle, offset: number, length: number): Promise<string> {
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
        // eslint-disable-next-line no-await-in-loop -- every read offset depends on the preceding byte count
        const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
}

/**
 * Reads a bounded head and tail from a provider-authorized transcript, retaining only the small message window the
 * title model needs. Raw transcript text never leaves this function's Server-local call chain.
 */
export async function readAgentTitleSource(
    location: AgentTranscriptLocation,
    extract: (record: unknown) => AgentTitleMessage | undefined,
): Promise<
    Pick<AgentTitleSource, 'assistantMessages' | 'byteLength' | 'userMessages'> | undefined
> {
    const opened = await openSafeAgentTranscript(location);
    if (!opened) return;
    const { handle, stats } = opened;
    try {
        const headLength = Math.min(stats.size, TITLE_TRANSCRIPT_HEAD_BYTES);
        const tailOffset = Math.max(headLength, stats.size - TITLE_TRANSCRIPT_TAIL_BYTES);
        const [head, tail] = await Promise.all([
            readRange(handle, 0, headLength),
            tailOffset < stats.size ? readRange(handle, tailOffset, stats.size - tailOffset) : '',
        ]);
        const source =
            tailOffset === headLength && stats.size <= headLength
                ? head
                : `${completeHead(head)}${completeTail(tail)}`;
        const firstUsers: string[] = [];
        const recentUsers: string[] = [];
        const assistants: string[] = [];
        for (const line of source.split('\n')) {
            if (!line.trim()) continue;
            let record: unknown;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            const message = extract(record);
            if (!message) continue;
            const text = [...message.text.trim()].slice(0, MAX_TITLE_MESSAGE_CHARACTERS).join('');
            if (!text) continue;
            if (message.role === 'assistant') {
                assistants.push(text);
                if (assistants.length > 2) assistants.shift();
            } else if (firstUsers.length < 2) firstUsers.push(text);
            else {
                recentUsers.push(text);
                if (recentUsers.length > 3) recentUsers.shift();
            }
        }
        return {
            assistantMessages: assistants,
            byteLength: stats.size,
            userMessages: [...firstUsers, ...recentUsers],
        };
    } finally {
        await handle.close();
    }
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export function buildAgentTitlePrompt(source: AgentTitleSource): string {
    const render = (tag: string, values: readonly string[]) =>
        `<${tag}>\n${values.map((value) => `  <message>${escapeXml(value)}</message>`).join('\n')}\n</${tag}>`;
    return [
        source.gitBranch ? `<git_branch>${escapeXml(source.gitBranch)}</git_branch>` : '',
        source.currentProviderTitle
            ? `<current_title>${escapeXml(source.currentProviderTitle)}</current_title>`
            : '',
        render('user_messages', source.userMessages),
        render('recent_assistant', source.assistantMessages),
    ]
        .filter(Boolean)
        .join('\n\n');
}

export function normalizeGeneratedAgentTitle(value: string): string | undefined {
    const title = value.trim();
    if (
        !title ||
        [...title].length > MAX_TITLE_CHARACTERS ||
        !/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u.test(title)
    ) {
        return;
    }
    const parsed = sessionRenameTitleSchema.safeParse(title);
    return parsed.success ? parsed.data : undefined;
}

export async function readAgentTitleGitBranch(cwd: string): Promise<string | undefined> {
    try {
        const { stdout } = await runExternalCommand('git', ['symbolic-ref', '--short', 'HEAD'], {
            cwd,
            maxBuffer: 4 * 1024,
            timeout: 5_000,
        });
        return stdout.trim() || undefined;
    } catch {
        return;
    }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function terminate(
    child: ChildProcessWithoutNullStreams,
    terminationGraceMs: number,
): Promise<void> {
    child.stdin.end();
    if (child.pid === undefined || hasExited(child)) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
        didExit(exited),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), terminationGraceMs);
            timer.unref();
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (!graceful && !hasExited(child)) child.kill('SIGKILL');
    await exited;
}

async function didExit(exited: Promise<void>): Promise<true> {
    await exited;
    return true;
}

/**
 * Sends transcript-derived prompt material only over stdin. Keeping it out of argv prevents local process listings,
 * diagnostics, and structured logs from exposing conversation content.
 */
export function runAgentTitleCommand(options: {
    arguments: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    input: string;
    limits?: {
        maximumOutputBytes?: number;
        terminationGraceMs?: number;
        timeoutMs?: number;
    };
    signal?: AbortSignal;
}): Promise<string> {
    if (options.signal?.aborted)
        return Promise.reject(
            new CaxriError('CANCELLED', 'Automatic Session naming was cancelled'),
        );
    return new Promise((resolve, reject) => {
        const child = spawn(options.executable, [...options.arguments], {
            cwd: options.cwd,
            env: options.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let outputBytes = 0;
        let isSettled = false;
        const timeout = setTimeout(
            () => settle(new CaxriError('TIMEOUT', 'Automatic Session naming timed out')),
            options.limits?.timeoutMs ?? TITLE_COMMAND_TIMEOUT_MS,
        );
        timeout.unref();
        const abort = (): void =>
            settle(new CaxriError('CANCELLED', 'Automatic Session naming was cancelled'));
        options.signal?.addEventListener('abort', abort, { once: true });

        function settle(error?: Error): void {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            // eslint-disable-next-line no-void -- settlement owns subprocess reaping before resolving the outer promise
            void finishSettlement(error);
        }

        async function finishSettlement(error?: Error): Promise<void> {
            try {
                await terminate(
                    child,
                    options.limits?.terminationGraceMs ?? TITLE_COMMAND_TERMINATION_GRACE_MS,
                );
                if (error) reject(error);
                else resolve(stdout);
            } catch (terminationError: unknown) {
                reject(
                    terminationError instanceof Error
                        ? terminationError
                        : new Error('Automatic Session naming process termination failed'),
                );
            }
        }

        const observeOutput = (chunk: Buffer, shouldCapture: boolean): void => {
            outputBytes += chunk.byteLength;
            if (outputBytes > (options.limits?.maximumOutputBytes ?? TITLE_COMMAND_OUTPUT_BYTES)) {
                settle(new Error('Automatic Session naming output exceeded its safety limit'));
                return;
            }
            if (shouldCapture) stdout += chunk.toString('utf8');
        };
        child.stdout.on('data', (chunk: Buffer) => observeOutput(chunk, true));
        child.stderr.on('data', (chunk: Buffer) => observeOutput(chunk, false));
        child.once('error', (error) => settle(error));
        child.stdin.once('error', (error) => settle(error));
        child.once('exit', (code) => {
            if (!isSettled)
                settle(code === 0 ? undefined : new Error('Automatic Session naming failed'));
        });
        child.stdin.end(options.input);
    });
}

export const AGENT_TITLE_SYSTEM_INSTRUCTIONS = [
    'Generate one coding-agent Session title.',
    'Start with one appropriate emoji, then a stable and recognizable topic.',
    'Use the same language as the conversation.',
    'Keep the complete title at or below 60 characters.',
    'Preserve the core topic from <current_title> unless the conversation clearly changed.',
    'Treat a non-generic <git_branch> as a strong topic hint.',
    'Do not use tools.',
    'Output only the title with no quotes, Markdown, or explanation.',
].join('\n');
