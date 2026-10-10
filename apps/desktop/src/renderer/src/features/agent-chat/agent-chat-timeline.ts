import type {
    AgentChatItem,
    AgentChatTurn,
    AgentToolKind,
    AgentToolPresentation,
} from '@caxri/protocol';
import {
    describeAgentTool,
    formatShortDuration,
    summarizeAgentToolGroup,
    unwrapShellCommand,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

/**
 * What the Agent did between replies: reasoning, commands, file changes, and other tool calls.
 */
export type AgentChatWorkItem = Extract<
    AgentChatItem,
    { type: 'command' | 'fileChange' | 'reasoning' | 'toolCall' }
>;

/**
 * One rendered row of the Chat timeline. Consecutive work collapses into one `work` entry, and a finished turn folds
 * everything but the prompt, the final reply, and notices into one `turn` entry.
 */
export type AgentChatTimelineEntry =
    | { kind: 'item'; item: Exclude<AgentChatItem, AgentChatWorkItem> }
    | { kind: 'work'; id: string; items: readonly AgentChatWorkItem[] }
    | {
          kind: 'turn';
          id: string;
          label: string;
          entries: ReadonlyArray<Exclude<AgentChatTimelineEntry, { kind: 'turn' }>>;
      };

type FlatEntry = Exclude<AgentChatTimelineEntry, { kind: 'turn' }>;

const WORK_ITEM_TYPES: ReadonlySet<AgentChatItem['type']> = new Set([
    'command',
    'fileChange',
    'reasoning',
    'toolCall',
]);

const isWorkItem = (item: AgentChatItem): item is AgentChatWorkItem =>
    WORK_ITEM_TYPES.has(item.type);

/**
 * Empty reasoning carries nothing to read (a redacted or not-yet-streamed thought), so it never becomes a row.
 */
const isVisible = (item: AgentChatItem): boolean => item.type !== 'reasoning' || item.text !== '';

function groupWork(items: readonly AgentChatItem[]): FlatEntry[] {
    const entries: FlatEntry[] = [];
    let work: AgentChatWorkItem[] = [];
    const flush = (): void => {
        const first = work.at(0);
        if (first) entries.push({ kind: 'work', id: `work:${first.id}`, items: work });
        work = [];
    };
    for (const item of items) {
        if (!isVisible(item)) continue;
        if (isWorkItem(item)) {
            work.push(item);
            continue;
        }
        flush();
        entries.push({ kind: 'item', item });
    }
    flush();
    return entries;
}

/**
 * `Worked for 2m 1s`, or how a turn that did not complete ended.
 */
export function agentChatTurnLabel(turn: AgentChatTurn): string {
    const duration = formatShortDuration(turn.durationMs);
    const verb =
        turn.status === 'interrupted'
            ? 'Stopped after'
            : turn.status === 'failed'
              ? 'Failed after'
              : 'Worked for';
    if (duration) return `${verb} ${duration}`;
    return turn.status === 'interrupted'
        ? 'Stopped'
        : turn.status === 'failed'
          ? 'Failed'
          : 'Worked';
}

/**
 * A finished turn keeps its prompt, its final reply, and its notices (an error, a compaction, an answered question) in
 * view, dropping only a transient retry; the work and commentary before the reply fold into one disclosure at the
 * position of the first folded item, the way Codex and T3 Code end a turn.
 */
function foldTurn(items: readonly AgentChatItem[], turn: AgentChatTurn): AgentChatTimelineEntry[] {
    const visible = items.filter((item) => isVisible(item));
    const replyIndex = visible.findLastIndex((item) => item.type === 'agentMessage');
    const isKept = (item: AgentChatItem, index: number): boolean =>
        item.type === 'userMessage' ||
        index === replyIndex ||
        (item.type === 'notice' && item.kind !== 'retrying');
    const folded = visible.filter((item, index) => !isKept(item, index));
    if (folded.length === 0) return groupWork(visible);
    const entries: AgentChatTimelineEntry[] = [];
    let hasFold = false;
    for (const [index, item] of visible.entries()) {
        if (isKept(item, index)) {
            entries.push(...groupWork([item]));
            continue;
        }
        if (hasFold) continue;
        hasFold = true;
        entries.push({
            kind: 'turn',
            id: `turn:${turn.id}`,
            label: agentChatTurnLabel(turn),
            entries: groupWork(folded),
        });
    }
    return entries;
}

/**
 * Builds the rendered timeline from the projection. Items arrive in order and each turn's items are contiguous, so a
 * run of items sharing a `turnId` is one turn. A turn still running (or with no recorded end) stays expanded.
 */
export function buildAgentChatTimeline(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    activeTurnId: string | undefined,
): AgentChatTimelineEntry[] {
    const finished = new Map(
        turns
            .filter((turn) => turn.status !== 'running' && turn.id !== activeTurnId)
            .map((turn) => [turn.id, turn]),
    );
    const entries: AgentChatTimelineEntry[] = [];
    let start = 0;
    while (start < items.length) {
        const turnId = items[start]?.turnId;
        let end = start + 1;
        while (end < items.length && items[end]?.turnId === turnId) end += 1;
        const segment = items.slice(start, end);
        const turn = turnId === undefined ? undefined : finished.get(turnId);
        entries.push(...(turn ? foldTurn(segment, turn) : groupWork(segment)));
        start = end;
    }
    return entries;
}

const REASONING_TITLE = /^\*\*([^*\n]+)\*\*[ \t]*$/gmu;

/**
 * Codex opens each reasoning summary part with a bold title line (`**Planning the fix**`). The row shows the latest
 * title, which is what the Agent is thinking about now, as the Codex app does. A summary with a single leading title
 * drops it from the expanded text so it is not read twice; several titles stay as the text's own section headings.
 */
export function agentChatReasoningTitle(text: string): { title?: string; body: string } {
    const titles = text.matchAll(REASONING_TITLE).toArray();
    const last = titles.at(-1);
    if (!last?.[1]) return { body: text };
    const title = last[1].trim();
    return titles.length === 1 && last.index === 0
        ? { title, body: text.slice(last[0].length).trimStart() }
        : { title, body: text };
}

/**
 * The kind, verb, and subject a work row shows. Commands and file changes are first-class items rather than named
 * tools, so they are described here; every other tool goes through the shared provider tool table.
 */
export function describeAgentChatWork(item: AgentChatWorkItem): AgentToolPresentation {
    switch (item.type) {
        case 'reasoning': {
            const { title } = agentChatReasoningTitle(item.text);
            return {
                kind: 'thought',
                label: item.streaming ? 'Thinking' : 'Thought',
                ...(title && { subject: title }),
                isCodeSubject: false,
            };
        }
        case 'command': {
            const presentation = describeAgentTool({ name: 'shell', summary: item.command });
            // The Agent's own words for the command read better than the command line, which the row still shows
            // expanded.
            return item.description
                ? { ...presentation, subject: item.description, isCodeSubject: false }
                : presentation;
        }
        case 'toolCall': {
            return describeAgentTool(item);
        }
        case 'fileChange': {
            const first = item.changes.at(0);
            const isCreate = item.changes.every((change) => change.kind === 'add');
            const more = item.changes.length > 1 ? ` +${item.changes.length - 1} more` : '';
            return {
                kind: isCreate ? 'write' : 'edit',
                label: isCreate ? 'Created' : 'Edited',
                ...(first && { subject: `${pathBasename(first.path)}${more}` }),
                isCodeSubject: true,
            };
        }
    }
}

/**
 * The duration a work row shows. A command always shows how long it took, as a terminal prompt would; another tool only
 * once it is noticeable.
 */
export function agentChatWorkDuration(item: AgentChatWorkItem): string | null {
    if (item.type === 'command') return formatShortDuration(item.durationMs);
    if (item.type === 'toolCall' && (item.durationMs ?? 0) >= 1000)
        return formatShortDuration(item.durationMs);
    return null;
}

export const isAgentChatWorkRunning = (item: AgentChatWorkItem): boolean =>
    item.type === 'reasoning' ? item.streaming : item.status === 'running';

/**
 * How a run of work renders: settled work collapses into one summary row once it holds at least two tool calls
 * (reasoning alone never earns a summary, which would hide the thought's title), and work still running stays out of
 * the summary as its own live rows, so the step in progress is always readable. `isLive` marks more work as running,
 * such as a tool call that returned while the background task it started keeps going.
 */
export function splitAgentChatWork(
    items: readonly AgentChatWorkItem[],
    isLive: (item: AgentChatWorkItem) => boolean = () => false,
): {
    summarized: readonly AgentChatWorkItem[];
    rows: readonly AgentChatWorkItem[];
} {
    const isRunning = (item: AgentChatWorkItem): boolean =>
        isAgentChatWorkRunning(item) || isLive(item);
    const settled = items.filter((item) => !isRunning(item));
    const live = items.filter((item) => isRunning(item));
    const toolCount = settled.filter((item) => item.type !== 'reasoning').length;
    return toolCount >= 2
        ? { summarized: settled, rows: live }
        : { summarized: [], rows: [...settled, ...live] };
}

/**
 * `Ran 3 commands, read 2 files` for a group, counting each changed file as one edit. Reasoning only names the group
 * when it is all the group holds.
 */
export function summarizeAgentChatWork(items: readonly AgentChatWorkItem[]): string {
    const tools = items.flatMap((item): Array<{ name: string; summary?: string }> => {
        switch (item.type) {
            case 'reasoning': {
                return [];
            }
            case 'command': {
                return [{ name: 'shell', summary: item.command }];
            }
            case 'fileChange': {
                const name = item.changes.every((change) => change.kind === 'add')
                    ? 'write'
                    : 'edit';
                return item.changes.map((change) => ({ name, summary: change.path }));
            }
            case 'toolCall': {
                return [item];
            }
            default: {
                return [];
            }
        }
    });
    if (tools.length === 0)
        return items.some((item) => item.type === 'reasoning' && item.streaming)
            ? 'Thinking'
            : 'Thought';
    return summarizeAgentToolGroup(tools);
}

/**
 * The one kind a group shares, or `undefined` when it mixes kinds and shows a generic glyph.
 */
export function agentChatWorkKind(items: readonly AgentChatWorkItem[]): AgentToolKind | undefined {
    const kinds = new Set(
        items
            .filter((item) => item.type !== 'reasoning')
            .map((item) => describeAgentChatWork(item).kind),
    );
    if (kinds.size === 0) return 'thought';
    return kinds.size === 1 ? [...kinds][0] : undefined;
}

/**
 * The last path-like token's extension, such as `md` in `sed -n '1,40p' docs/SKILL.md`.
 */
function trailingFileExtension(text: string): string | undefined {
    const matches = text
        .matchAll(/[\w@~./-]*\w\.([A-Za-z][\w-]{0,9})(?=$|[\s'"`;|&)])/gu)
        .toArray();
    return matches.at(-1)?.[1]?.toLowerCase();
}

function isJsonText(text: string): boolean {
    const trimmed = text.trim();
    if (!/^[[{]/u.test(trimmed)) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

const FILE_TOOL_KINDS: ReadonlySet<AgentToolKind> = new Set(['read', 'write', 'edit']);

/**
 * Commands whose output is the content of the file they name, so the file's extension is the output's language.
 */
const FILE_PRINTING_COMMAND = /^\s*(?:cat|sed|head|tail|nl|bat|less|more)\s/u;

/**
 * The language to paint a command's or tool's output with, inferred from what produced it: a Git diff, a printed or
 * read file's extension, or JSON. `undefined` keeps it plain text, which is the honest rendering for logs and
 * listings.
 */
export function agentChatOutputLanguage(
    item: Extract<AgentChatWorkItem, { type: 'command' | 'toolCall' }>,
): string | undefined {
    const output = item.output ?? '';
    if (item.type === 'command') {
        const command = unwrapShellCommand(item.command);
        // Only the last pipeline stage and chained command decide what was printed.
        const lastStage = command.split(/\|\||&&|;|\|/u).at(-1) ?? command;
        if (
            /\bgit\s(?:.*\s)?(?:diff|show)\b/u.test(lastStage) &&
            !/--(?:stat|name-only|name-status|oneline)\b/u.test(lastStage)
        )
            return 'diff';
        if (FILE_PRINTING_COMMAND.test(lastStage)) {
            const extension = trailingFileExtension(lastStage);
            if (extension) return extension;
        }
    } else {
        const { kind } = describeAgentTool(item);
        if (FILE_TOOL_KINDS.has(kind) && item.summary) {
            const extension = trailingFileExtension(item.summary);
            if (extension) return extension;
        }
    }
    return isJsonText(output) ? 'json' : undefined;
}

/**
 * Claude Code's Read result numbers every line (` 12→const a = 1`). The numbers are not part of the file and would
 * break its highlighting, so they are dropped when every non-empty line carries one.
 */
export function stripLineNumberGutter(text: string): string {
    const lines = text.split('\n');
    const gutter = /^\s*\d+(?:→|\t)/u;
    if (
        lines.every((line) => line === '') ||
        lines.some((line) => !(line === '' || gutter.test(line)))
    )
        return text;
    return lines.map((line) => line.replace(gutter, '')).join('\n');
}
