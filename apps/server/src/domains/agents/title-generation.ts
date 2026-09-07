import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

import { sessionRenameTitleSchema } from '@caxri/protocol';

import { runExternalCommand } from '../executables';
import type { AgentTitleSource } from './contract';
import type { AgentTextCommandOptions } from './text-generation';
import { runAgentTextCommand } from './text-generation';
import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript } from './transcript-security';

const MAX_TITLE_CHARACTERS = 32;
const MAX_CJK_TITLE_UNITS = 12;
const MAX_NON_CJK_TITLE_WORDS = 5;
const MAX_TITLE_MESSAGE_CHARACTERS = 400;
const TITLE_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const TITLE_TRANSCRIPT_TAIL_BYTES = 768 * 1024;

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
    if (!title || [...title].length > MAX_TITLE_CHARACTERS) return;
    if (
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u{FE0F}\u{20E3}]/u.test(
            title,
        )
    )
        return;
    const cjkCharacters = title.match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    );
    const titleWithoutCjk = title.replaceAll(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        ' ',
    );
    const words = titleWithoutCjk.match(/[\p{L}\p{N}]+(?:[+#._'/-][\p{L}\p{N}]+)*/gu);
    const cjkCount = cjkCharacters?.length ?? 0;
    const wordCount = words?.length ?? 0;
    if (
        cjkCount === 0
            ? wordCount === 0 || wordCount > MAX_NON_CJK_TITLE_WORDS
            : cjkCount + wordCount > MAX_CJK_TITLE_UNITS
    )
        return;
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

/**
 * Sends transcript-derived prompt material only over stdin. Keeping it out of argv prevents local process listings,
 * diagnostics, and structured logs from exposing conversation content.
 */
export function runAgentTitleCommand(
    options: Omit<AgentTextCommandOptions, 'operation'>,
): Promise<string> {
    return runAgentTextCommand({ ...options, operation: 'Automatic Session naming' });
}

export const AGENT_TITLE_SYSTEM_INSTRUCTIONS = [
    'Generate one coding-agent Session title.',
    'Use a stable and recognizable topic phrase, not a sentence.',
    'Use the dominant language of the conversation.',
    'Do not use emoji.',
    'For a title containing CJK characters, use at most 12 title units: each CJK character and each Latin or numeric word counts as one unit.',
    'For a title without CJK characters, use at most 5 words.',
    'Keep the complete title at or below 32 characters.',
    'Prefer the specific object and task, such as "Codex 自动命名" or "Refine Session Naming".',
    'Preserve the core topic from <current_title> unless the conversation clearly changed.',
    'Name what the conversation itself is about. A non-generic <git_branch> is only a secondary hint for disambiguation; never let it override a topic the messages state clearly.',
    'Do not use tools.',
    'Output only the title with no quotes, Markdown, or explanation.',
].join('\n');
