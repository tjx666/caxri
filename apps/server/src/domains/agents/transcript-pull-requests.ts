import type { TranscriptScanCursor } from './transcript-scan';

export interface TranscriptPullRequestReference {
    number: number;
    owner: string;
    repo: string;
    url: string;
}

/**
 * Pull request links harvested from one Agent transcript. `created` is authoritative: it came back from a `gh pr
 * create` the Agent itself ran. `mentioned` is the most recent link the Agent wrote in its own prose and only matters
 * when the Session never created one (e.g. the user asked the Agent to check on an existing PR).
 */
export interface TranscriptPullRequestScan extends TranscriptScanCursor {
    created?: TranscriptPullRequestReference;
    mentioned?: TranscriptPullRequestReference;
    /**
     * Tool-use ids of pending `gh pr create` invocations whose result record has not been scanned yet.
     */
    pendingCreateToolUseIds: Set<string>;
}

/**
 * A runaway transcript that keeps invoking `gh pr create` without a result must not grow the pending set forever.
 */
const MAX_PENDING_CREATE_TOOL_USES = 16;
const PULL_REQUEST_URL_PATTERN =
    /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?![\w/])/g;
const PR_CREATE_COMMAND_PATTERN = /\bgh\s+pr\s+create\b/;

interface TranscriptContentBlock {
    id?: unknown;
    input?: unknown;
    name?: unknown;
    text?: unknown;
    tool_use_id?: unknown;
    type?: unknown;
    content?: unknown;
}

interface TranscriptRecord {
    message?: { content?: unknown };
    type?: unknown;
}

export function createTranscriptPullRequestScan(): TranscriptPullRequestScan {
    return { offset: 0, pendingCreateToolUseIds: new Set() };
}

export function resetTranscriptPullRequestScan(scan: TranscriptPullRequestScan): void {
    scan.created = undefined;
    scan.mentioned = undefined;
    scan.pendingCreateToolUseIds.clear();
}

/**
 * Returns the last pull request link in `text`; the CLI prints the created PR URL as its final stdout line, and a later
 * mention in prose is the more current one.
 */
export function lastPullRequestReference(text: string): TranscriptPullRequestReference | undefined {
    let reference: TranscriptPullRequestReference | undefined;
    for (const match of text.matchAll(PULL_REQUEST_URL_PATTERN)) {
        const number = Number(match[3]);
        if (!Number.isSafeInteger(number) || number <= 0) continue;
        reference = { owner: match[1], repo: match[2], number, url: match[0] };
    }
    return reference;
}

function isContentBlock(value: unknown): value is TranscriptContentBlock {
    return typeof value === 'object' && value !== null;
}

function blockText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const block of content as unknown[]) {
        if (isContentBlock(block) && typeof block.text === 'string') text += `${block.text}\n`;
    }
    return text;
}

function scanAssistantBlocks(blocks: readonly unknown[], scan: TranscriptPullRequestScan): void {
    for (const block of blocks) {
        if (!isContentBlock(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            const reference = lastPullRequestReference(block.text);
            if (reference) scan.mentioned = reference;
            continue;
        }
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const input = block.input as { command?: unknown } | undefined;
        if (typeof input?.command !== 'string' || !PR_CREATE_COMMAND_PATTERN.test(input.command))
            continue;
        rememberPendingCreate(scan, block.id);
    }
}

function rememberPendingCreate(scan: TranscriptPullRequestScan, toolUseId: string): void {
    scan.pendingCreateToolUseIds.add(toolUseId);
    while (scan.pendingCreateToolUseIds.size > MAX_PENDING_CREATE_TOOL_USES) {
        const oldest = scan.pendingCreateToolUseIds.values().next().value;
        if (oldest === undefined) return;
        scan.pendingCreateToolUseIds.delete(oldest);
    }
}

function scanToolResultBlocks(blocks: readonly unknown[], scan: TranscriptPullRequestScan): void {
    for (const block of blocks) {
        if (!isContentBlock(block) || block.type !== 'tool_result') continue;
        if (typeof block.tool_use_id !== 'string') continue;
        if (!scan.pendingCreateToolUseIds.delete(block.tool_use_id)) continue;
        const reference = lastPullRequestReference(blockText(block.content));
        if (reference) scan.created = reference;
    }
}

/**
 * Consumes one Claude Code transcript line. Only Agent-authored records are inspected: `gh pr create` tool results bind
 * the Session to the PR it delivered, and assistant prose supplies the fallback mention. User prompts are skipped so a
 * pasted link never masquerades as the Session's own delivery. Lines without a PR link or a create command are rejected
 * before JSON parsing so the incremental scan stays cheap.
 */
export function scanTranscriptPullRequestLine(line: string, scan: TranscriptPullRequestScan): void {
    const mayCreate = line.includes('gh pr create');
    if (!mayCreate && !line.includes('/pull/')) return;
    let record: TranscriptRecord;
    try {
        record = JSON.parse(line) as TranscriptRecord;
    } catch {
        return;
    }
    const content: unknown = record.message?.content;
    if (!Array.isArray(content)) return;
    const blocks: readonly unknown[] = content;
    if (record.type === 'assistant') scanAssistantBlocks(blocks, scan);
    else if (record.type === 'user') scanToolResultBlocks(blocks, scan);
}
