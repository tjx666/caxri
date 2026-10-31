import type { AcceptanceReference } from '../acceptance-link';
import { findAcceptanceLinks } from '../acceptance-link';
import type { TranscriptScanCursor } from './transcript-scan';

/**
 * One Linear issue the conversation named. `workspace` is present only when the reference arrived as a `linear.app`
 * URL, which is the only form that carries the workspace slug.
 */
export interface TranscriptLinearReference {
    identifier: string;
    workspace?: string;
}

/**
 * Conversation context harvested from one Agent transcript, kept as bounded most-recent-last lists.
 *
 * Every list is a _candidate_ list, never an authority. Directories and branches are matched against live Git worktree
 * topology before they reach the user, and identifiers are matched against a resolved Linear team-key allow-list, so a
 * path or marker the Agent merely printed can never widen what Caxri will open or claim to know.
 */
export interface TranscriptSessionContextScan extends TranscriptScanCursor {
    acceptanceReferences: AcceptanceReference[];
    branches: string[];
    directories: string[];
    linearReferences: TranscriptLinearReference[];
}

const MAX_BRANCHES = 16;
const MAX_DIRECTORIES = 16;
/**
 * Generous because an identifier is at most twelve characters and only the leading one is ever resolved; a tight bound
 * would let a burst of later mentions evict the marker the user opened the conversation with.
 */
const MAX_LINEAR_REFERENCES = 32;
/**
 * Tighter than the Linear bound because the input is: a full URL is deliberate every time, so there is no accidental
 * traffic to leave room for, and a Session works through a handful of acceptance reports at most.
 */
const MAX_ACCEPTANCE_REFERENCES = 8;
/**
 * A transcript line is one JSON record; a tool invocation that pastes a whole file can make it very large. The content
 * patterns below are bounded scans, but running six of them over a multi-megabyte line buys nothing: the load-bearing
 * signals (`cwd`, `gitBranch`, a command line, a prompt) all sit near the front of their record.
 */
const MAX_CONTENT_SCAN_CHARS = 64 * 1024;

/**
 * Absolute POSIX paths only. A relative `cd` target cannot be resolved without replaying the shell's own directory
 * stack, and a worktree root is always absolute.
 *
 * `"` counts as a delimiter before `cd` because the command arrives as a JSON string value (`{"command":"cd /repo…"}`),
 * which is exactly where a leading `cd` is most common.
 *
 * The `worktree add` flag run is capped at eight. Each `-flag` can match either as a bare flag or as a flag with a
 * separate value, so an unbounded `*` over that alternation backtracks exponentially: a line carrying thirty
 * consecutive `-` tokens and no trailing path took ~36ms, and each further pair doubled it: on Server Core's single
 * event loop, blocking every Session's IPC. A real `git worktree add` never carries eight flags.
 */
const WORKING_DIRECTORY_PATTERN =
    /(?:"(?:workdir|cwd|directory)"\s*:\s*"|(?:^|[\s";&|(])cd\s+|\bgit\s+-C\s+|worktree\s+add\s+(?:-[\w-]+(?:[= ]\S+)?\s+){0,8})(\/[^\s"';&|)]+)/g;
/**
 * Raw-line fast path for the per-record working directory both providers write: Claude Code on every record, Codex on
 * `session_meta` and `turn_context`. Reading it without `JSON.parse` keeps an untouched prose record cheap.
 *
 * A path needing JSON escaping simply fails to match here, and then fails to match the topology too, so the shortcut is
 * fail-safe rather than merely approximate.
 */
const RECORD_DIRECTORY_PATTERN = /"cwd"\s*:\s*"([^"\\]+)"/g;
const RECORD_BRANCH_PATTERN = /"gitBranch"\s*:\s*"([^"\\]+)"/;
const BRANCH_COMMAND_PATTERN = /\bgit\s+(?:switch|checkout)\s+(?:-[\w-]+\s+)*([\w./-]+)/g;
const WORKTREE_BRANCH_PATTERN = /-b\s+([\w./-]+)/g;
const LINEAR_URL_PATTERN =
    /https?:\/\/linear\.app\/([a-z\d-]+)\/issue\/([a-z][a-z\d]*-[1-9]\d*)/giu;
/**
 * A bare Linear marker. Uppercase-only already rejects `gpt-5` and `utf-8`, but not `UTF-8` or `RFC-2119`; the team-key
 * allow-list in `external-status/linear.ts` is what actually decides, and this pattern only has to be cheap and
 * complete.
 */
const LINEAR_IDENTIFIER_PATTERN = /\b([A-Z][A-Z\d]{1,9})-([1-9]\d{0,6})\b/g;
/**
 * Prefixes that are never a Linear team, dropped before the bounded list rather than at the allow-list.
 *
 * Ordinary Agent prose is full of these: an eight-slot list filled with `UTF-8`, `GPT-4`, `SHA-256` and friends would
 * silently push out the one real marker the user typed, and the allow-list runs too late to save it. Rejecting them
 * here also keeps a repository that never mentions an issue from spawning `linear` to ask about a text encoding.
 *
 * Only unambiguous standards, algorithms, and model families belong here; a real team key that collides with one is a
 * problem this list cannot solve, so it stays short rather than clever.
 */
const NON_ISSUE_PREFIXES: ReadonlySet<string> = new Set([
    'AES',
    'ARIA',
    'CVE',
    'GPT',
    'HTTP',
    'ISO',
    'MD',
    'RFC',
    'SHA',
    'UTF',
    'WCAG',
]);

/**
 * Shared with the branch-name reader so both low-precision sources reject the same non-issue prefixes, and the team-key
 * allow-list is consulted only when something plausible is actually waiting on it.
 */
export function isNonIssuePrefix(teamKey: string): boolean {
    return NON_ISSUE_PREFIXES.has(teamKey.toUpperCase());
}
const LINEAR_IDENTIFIER_HINT = /[A-Z][A-Z\d]{1,9}-\d/;
const WORKTREE_TEXT_HINT = /workdir|\bcd\s|git\s+(?:-C|switch|checkout|worktree)/;

/**
 * Harness-injected envelopes that ride along inside a user record: repository instructions, hook output, and reminder
 * blocks the user never typed. A contributor guide that documents "reference issues as `ABC-123`" quotes that marker as
 * a format example, and scanning it would bind every Session in that repository to `ABC-123`.
 */
const INSTRUCTION_ENVELOPE_PATTERN =
    /<(INSTRUCTIONS|system-reminder|user_instructions|user-prompt-submit-hook|environment_context|command-message|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

interface TranscriptContentBlock {
    content?: unknown;
    input?: unknown;
    text?: unknown;
    type?: unknown;
}

interface SessionContextRecord {
    cwd?: unknown;
    gitBranch?: unknown;
    message?: { content?: unknown; role?: unknown };
    payload?: unknown;
    type?: unknown;
}

interface CodexContextItem {
    arguments?: unknown;
    content?: unknown;
    cwd?: unknown;
    input?: unknown;
    role?: unknown;
    type?: unknown;
}

export function createTranscriptSessionContextScan(): TranscriptSessionContextScan {
    return {
        offset: 0,
        acceptanceReferences: [],
        branches: [],
        directories: [],
        linearReferences: [],
    };
}

export function resetTranscriptSessionContextScan(scan: TranscriptSessionContextScan): void {
    scan.acceptanceReferences.length = 0;
    scan.branches.length = 0;
    scan.directories.length = 0;
    scan.linearReferences.length = 0;
}

/**
 * Appends `value` as the most recent entry, moving an earlier occurrence rather than duplicating it, and drops the
 * oldest entry once the list is full. Recency is the whole ranking signal, so a re-mention has to move.
 */
function rememberRecent(values: string[], value: string, limit: number): void {
    const existing = values.indexOf(value);
    if (existing !== -1) values.splice(existing, 1);
    values.push(value);
    if (values.length > limit) values.splice(0, values.length - limit);
}

function rememberDirectory(scan: TranscriptSessionContextScan, value: string): void {
    // Trailing separators and command punctuation would defeat the exact comparison against a worktree root path.
    const trimmed = value.replace(/[,.:)\]}]+$/, '').replace(/\/+$/, '');
    if (trimmed.length > 1 && trimmed.startsWith('/'))
        rememberRecent(scan.directories, trimmed, MAX_DIRECTORIES);
}

function rememberBranch(scan: TranscriptSessionContextScan, value: string): void {
    // A leading `-` is a flag the command pattern over-captured, and `-` alone is shell for "the previous branch",
    // which names nothing durable.
    if (value.length > 0 && !value.startsWith('-'))
        rememberRecent(scan.branches, value, MAX_BRANCHES);
}

function rememberLinear(
    scan: TranscriptSessionContextScan,
    identifier: string,
    workspace?: string,
): void {
    const normalized = identifier.toUpperCase();
    const existing = scan.linearReferences.findIndex(
        (reference) => reference.identifier === normalized,
    );
    // A later URL mention upgrades an earlier bare marker by supplying the workspace slug; a later bare mention never
    // discards a slug the conversation already proved.
    const slug =
        workspace?.toLowerCase() ??
        (existing === -1 ? undefined : scan.linearReferences[existing].workspace);
    if (existing !== -1) scan.linearReferences.splice(existing, 1);
    scan.linearReferences.push({ identifier: normalized, ...(slug && { workspace: slug }) });
    if (scan.linearReferences.length > MAX_LINEAR_REFERENCES)
        scan.linearReferences.splice(0, scan.linearReferences.length - MAX_LINEAR_REFERENCES);
}

/**
 * A re-mention moves the report to the most recent position, and a round travels with it: pasting the link again is how
 * a conversation says "this round now". A later link that pins no round leaves the last known one in place rather than
 * erasing it, because dropping to "the report as a whole" would silently change which round the chip is reporting.
 */
function rememberAcceptance(
    scan: TranscriptSessionContextScan,
    id: string,
    round: number | undefined,
): void {
    const normalized = id.toLowerCase();
    const existing = scan.acceptanceReferences.findIndex(
        (reference) => reference.id === normalized,
    );
    const pinned =
        round ?? (existing === -1 ? undefined : scan.acceptanceReferences[existing].round);
    if (existing !== -1) scan.acceptanceReferences.splice(existing, 1);
    scan.acceptanceReferences.push({ id: normalized, ...(pinned && { round: pinned }) });
    if (scan.acceptanceReferences.length > MAX_ACCEPTANCE_REFERENCES)
        scan.acceptanceReferences.splice(
            0,
            scan.acceptanceReferences.length - MAX_ACCEPTANCE_REFERENCES,
        );
}

function boundedText(value: string): string {
    return value.length > MAX_CONTENT_SCAN_CHARS ? value.slice(0, MAX_CONTENT_SCAN_CHARS) : value;
}

function scanLinearUrls(text: string, scan: TranscriptSessionContextScan): void {
    for (const match of text.matchAll(LINEAR_URL_PATTERN)) rememberLinear(scan, match[2], match[1]);
}

function scanAcceptanceUrls(text: string, scan: TranscriptSessionContextScan): void {
    for (const reference of findAcceptanceLinks(text))
        rememberAcceptance(scan, reference.id, reference.round);
}

/**
 * Prose written by the user or the Agent. Both count: the user naming an issue in the prompt is the strongest binding
 * signal there is, and unlike a pull request link there is no "whose delivery is this" question a pasted marker could
 * answer wrongly.
 */
function scanProse(text: string, scan: TranscriptSessionContextScan): void {
    const bounded = boundedText(text).replaceAll(INSTRUCTION_ENVELOPE_PATTERN, ' ');
    scanLinearUrls(bounded, scan);
    scanAcceptanceUrls(bounded, scan);
    for (const match of bounded.matchAll(LINEAR_IDENTIFIER_PATTERN))
        // A `linear.app` URL proves its own workspace, so only the bare form is filtered.
        if (!isNonIssuePrefix(match[1])) rememberLinear(scan, `${match[1]}-${match[2]}`);
}

/**
 * The text of a tool invocation: a shell command line, a `workdir` argument. Deliberately not its output: a command
 * that prints a repository's history would backfill directories and markers nobody in this conversation chose.
 */
function scanInvocation(text: string, scan: TranscriptSessionContextScan): void {
    const bounded = boundedText(text);
    for (const match of bounded.matchAll(WORKING_DIRECTORY_PATTERN))
        rememberDirectory(scan, match[1]);
    for (const match of bounded.matchAll(BRANCH_COMMAND_PATTERN)) rememberBranch(scan, match[1]);
    if (bounded.includes('worktree add'))
        for (const match of bounded.matchAll(WORKTREE_BRANCH_PATTERN))
            rememberBranch(scan, match[1]);
    scanLinearUrls(bounded, scan);
    scanAcceptanceUrls(bounded, scan);
}

function isRecord(value: unknown): value is TranscriptContentBlock {
    return typeof value === 'object' && value !== null;
}

function blockText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const block of content as unknown[])
        if (isRecord(block) && typeof block.text === 'string') text += `${block.text}\n`;
    return text;
}

/**
 * Claude records both roles as a content-block array. Only typed `text` blocks are somebody's own words: a `user`
 * record also carries `tool_result` blocks, which are command output and deliberately not scanned.
 */
function scanClaudeBlocks(blocks: readonly unknown[], scan: TranscriptSessionContextScan): void {
    for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            scanProse(block.text, scan);
            continue;
        }
        if (block.type === 'tool_use' && block.input !== undefined)
            scanInvocation(JSON.stringify(block.input), scan);
    }
}

function scanCodexItem(payload: unknown, scan: TranscriptSessionContextScan): void {
    if (!isRecord(payload)) return;
    const item = payload as CodexContextItem;
    if (typeof item.cwd === 'string') rememberDirectory(scan, item.cwd);
    switch (item.type) {
        case 'function_call':
        case 'custom_tool_call': {
            const invocation = item.type === 'function_call' ? item.arguments : item.input;
            if (typeof invocation === 'string') scanInvocation(invocation, scan);
            return;
        }
        case 'message': {
            if (item.role !== 'assistant' && item.role !== 'user') return;
            const text = blockText(item.content);
            if (text) scanProse(text, scan);
            return;
        }
        default:
    }
}

/**
 * Consumes one Claude Code or Codex transcript line, accumulating the worktree and Linear clues this conversation
 * produced. Records that carry neither prose nor a command are answered from the raw line without `JSON.parse`, so an
 * ordinary reasoning or token-accounting record costs two regular expressions.
 */
export function scanTranscriptSessionContextLine(
    line: string,
    scan: TranscriptSessionContextScan,
): void {
    if (line.length === 0) return;
    const needsContent =
        line.includes('linear.app') ||
        line.includes('/acceptance/') ||
        LINEAR_IDENTIFIER_HINT.test(line) ||
        WORKTREE_TEXT_HINT.test(line);
    if (!needsContent) {
        for (const match of line.matchAll(RECORD_DIRECTORY_PATTERN))
            rememberDirectory(scan, match[1]);
        const branch = RECORD_BRANCH_PATTERN.exec(line);
        if (branch) rememberBranch(scan, branch[1]);
        return;
    }
    let record: SessionContextRecord;
    try {
        record = JSON.parse(line) as SessionContextRecord;
    } catch {
        return;
    }
    if (typeof record.cwd === 'string') rememberDirectory(scan, record.cwd);
    if (typeof record.gitBranch === 'string') rememberBranch(scan, record.gitBranch);
    if (record.type === 'session_meta' || record.type === 'turn_context') {
        const payload = record.payload;
        if (isRecord(payload) && typeof (payload as CodexContextItem).cwd === 'string')
            rememberDirectory(scan, (payload as CodexContextItem).cwd as string);
        return;
    }
    if (record.type === 'response_item') {
        scanCodexItem(record.payload, scan);
        return;
    }
    const content: unknown = record.message?.content;
    if (Array.isArray(content) && (record.type === 'assistant' || record.type === 'user'))
        scanClaudeBlocks(content, scan);
}
