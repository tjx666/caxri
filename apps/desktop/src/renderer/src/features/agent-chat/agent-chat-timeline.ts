import type {
    AgentChatItem,
    AgentChatTurn,
    AgentToolKind,
    AgentToolPresentation,
} from '@caxri/protocol';
import {
    agentToolOutcomeLabel,
    describeAgentTool,
    formatShortDuration,
    summarizeAgentToolGroup,
    unwrapShellCommand,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { agentChatMessageFullTime } from './agent-chat-time';
import type { AgentChatTurnArtifacts } from './agent-chat-turn-artifacts';
import { collectAgentChatTurnArtifacts } from './agent-chat-turn-artifacts';

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
    | {
          kind: 'item';
          item: Exclude<AgentChatItem, AgentChatWorkItem>;
          /**
           * The reply that ends a finished turn, the only one that carries a Copy action. Commentary between tool calls
           * stays action-free so the transcript does not reserve a row under every reply.
           */
          isFinalReply?: true;
          /**
           * What the finished turn this reply ends changed and filed, shown under the reply above its Copy action.
           */
          artifacts?: AgentChatTurnArtifacts;
          /**
           * The final reply of the most recent turn: its Copy action stays visible instead of waiting for hover, since
           * it is the reply the user most likely wants to take away. Earlier replies reveal theirs on hover or focus.
           */
          isLatestReply?: true;
      }
    | { kind: 'work'; id: string; items: readonly AgentChatWorkItem[] }
    | {
          /**
           * A finished turn's artifacts when the turn ended without a reply to carry them, such as a stopped turn.
           */
          kind: 'artifacts';
          id: string;
          artifacts: AgentChatTurnArtifacts;
      }
    | {
          kind: 'turn';
          id: string;
          label: string;
          /**
           * How the turn ended, so a failed or stopped turn's fold row carries its tone, not only its words.
           */
          status: AgentChatTurn['status'];
          /**
           * When the turn started and ended (epoch ms), for the fold row's tooltip; absent when the provider did not
           * say.
           */
          startedAt?: number;
          endedAt?: number;
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
 * Empty reasoning carries nothing to read (a redacted or not-yet-streamed thought), so it never becomes a row. Nor does
 * a reply that ended empty, such as one a stop cut off before its first word: it would render a Copy action with
 * nothing to copy. A reply still streaming stays, because its first words are on the way.
 */
const isVisible = (item: AgentChatItem): boolean => {
    if (item.type === 'reasoning') return item.text !== '';
    if (item.type === 'agentMessage') return item.streaming || item.text.trim() !== '';
    return true;
};

function groupWork(items: readonly AgentChatItem[], finalReplyId?: string): FlatEntry[] {
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
        entries.push({
            kind: 'item',
            item,
            ...(item.id === finalReplyId && { isFinalReply: true }),
        });
    }
    flush();
    return entries;
}

/**
 * `Worked for 2m 1s`, or how a turn that did not complete ended. A turn under a second reads as plain `Worked`, as a
 * work row drops its sub-second duration: `<1s` is noise.
 */
export function agentChatTurnLabel(turn: AgentChatTurn): string {
    const duration =
        (turn.durationMs ?? 0) >= 1000 ? formatShortDuration(turn.durationMs) : undefined;
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
 * The fold row's tooltip: when the turn finished, or when it started if its end is unknown.
 */
export function agentChatTurnTimeTooltip(
    entry: Pick<Extract<AgentChatTimelineEntry, { kind: 'turn' }>, 'endedAt' | 'startedAt'>,
): string | undefined {
    if (entry.endedAt !== undefined) return `Finished ${agentChatMessageFullTime(entry.endedAt)}`;
    if (entry.startedAt !== undefined)
        return `Started ${agentChatMessageFullTime(entry.startedAt)}`;
    return undefined;
}

/**
 * The semantic tone of a finished turn's fold row: a failed turn is `danger`, a stopped one `warning`, and a turn that
 * completed stays quiet (`undefined`), because a column of green fold rows would be noise.
 */
export function agentChatTurnTone(
    status: AgentChatTurn['status'],
): 'danger' | 'warning' | undefined {
    if (status === 'failed') return 'danger';
    return status === 'interrupted' ? 'warning' : undefined;
}

/**
 * A finished turn keeps its prompt, its final reply, and its notices (an error, a compaction, an answered question) in
 * view, dropping only a transient retry; the work and commentary before the reply fold into one disclosure at the
 * position of the first folded item, the way Codex and T3 Code end a turn.
 */
function foldTurn(
    items: readonly AgentChatItem[],
    turn: AgentChatTurn,
    finalReplyId: string | undefined,
): AgentChatTimelineEntry[] {
    const visible = items.filter((item) => isVisible(item));
    const replyIndex = visible.findIndex((item) => item.id === finalReplyId);
    const isKept = (item: AgentChatItem, index: number): boolean =>
        item.type === 'userMessage' ||
        index === replyIndex ||
        (item.type === 'notice' && item.kind !== 'retrying');
    const folded = visible.filter((item, index) => !isKept(item, index));
    if (folded.length === 0) return groupWork(visible, finalReplyId);
    const entries: AgentChatTimelineEntry[] = [];
    let hasFold = false;
    for (const [index, item] of visible.entries()) {
        if (isKept(item, index)) {
            entries.push(...groupWork([item], finalReplyId));
            continue;
        }
        if (hasFold) continue;
        hasFold = true;
        entries.push({
            kind: 'turn',
            id: `turn:${turn.id}`,
            label: agentChatTurnLabel(turn),
            status: turn.status,
            ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
            ...(turn.startedAt !== undefined &&
                turn.durationMs !== undefined && { endedAt: turn.startedAt + turn.durationMs }),
            entries: groupWork(folded),
        });
    }
    return entries;
}

/**
 * The last artifacts computed per turn, reused while the turn's items keep their identities. The projection replaces
 * only the item a patch touches, so a reply streaming in a later turn does not hand every earlier final reply a new
 * `artifacts` object and re-render it.
 */
const artifactsCache = new WeakMap<
    AgentChatItem,
    {
        turnId: string;
        items: readonly AgentChatItem[];
        artifacts: AgentChatTurnArtifacts | undefined;
    }
>();

function turnArtifacts(
    turnId: string,
    items: readonly AgentChatItem[],
): AgentChatTurnArtifacts | undefined {
    const first = items.at(0);
    if (!first) return undefined;
    const cached = artifactsCache.get(first);
    if (
        cached?.turnId === turnId &&
        cached.items.length === items.length &&
        cached.items.every((item, index) => item === items[index])
    )
        return cached.artifacts;
    const artifacts = collectAgentChatTurnArtifacts(turnId, items);
    artifactsCache.set(first, { turnId, items, artifacts });
    return artifacts;
}

/**
 * Hangs a finished turn's artifacts on its final reply, or appends them after the turn when it has none.
 */
function withTurnArtifacts(
    entries: AgentChatTimelineEntry[],
    artifacts: AgentChatTurnArtifacts | undefined,
): AgentChatTimelineEntry[] {
    if (!artifacts) return entries;
    const replyIndex = entries.findIndex((entry) => entry.kind === 'item' && entry.isFinalReply);
    const reply = replyIndex === -1 ? undefined : entries[replyIndex];
    if (reply?.kind !== 'item')
        return [...entries, { kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts }];
    return entries.with(replyIndex, { ...reply, artifacts });
}

/**
 * Builds the rendered timeline from the projection. Items arrive in order and each turn's items are contiguous, so a
 * run of items sharing a `turnId` is one turn. A turn still running (or with no recorded end) stays expanded. Every
 * turn not running ends on its last reply, which is the only one marked `isFinalReply`; a running turn's latest reply
 * may still be followed by more work, so it is not marked until the turn ends. The last turn's final reply is also
 * `isLatestReply`; while the last turn still runs, no reply is. History read back from before the live projection is
 * built with `hasLatestReply` off, since the latest reply is always in the live part.
 */
export function buildAgentChatTimeline(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    activeTurnId: string | undefined,
    hasLatestReply = true,
): AgentChatTimelineEntry[] {
    const finished = new Map(
        turns
            .filter((turn) => turn.status !== 'running' && turn.id !== activeTurnId)
            .map((turn) => [turn.id, turn]),
    );
    const running = new Set(
        turns.filter((turn) => turn.status === 'running').map((turn) => turn.id),
    );
    if (activeTurnId !== undefined) running.add(activeTurnId);
    const entries: AgentChatTimelineEntry[] = [];
    let start = 0;
    let latestReplyId: string | undefined;
    while (start < items.length) {
        const turnId = items[start]?.turnId;
        let end = start + 1;
        while (end < items.length && items[end]?.turnId === turnId) end += 1;
        const segment = items.slice(start, end);
        const turn = turnId === undefined ? undefined : finished.get(turnId);
        const finalReplyId =
            turnId !== undefined && running.has(turnId)
                ? undefined
                : segment.findLast((item) => item.type === 'agentMessage' && isVisible(item))?.id;
        entries.push(
            ...(turn
                ? withTurnArtifacts(
                      foldTurn(segment, turn, finalReplyId),
                      turnArtifacts(turn.id, segment),
                  )
                : groupWork(segment, finalReplyId)),
        );
        latestReplyId = finalReplyId;
        start = end;
    }
    return latestReplyId === undefined || !hasLatestReply
        ? entries
        : entries.map((entry) =>
              entry.kind === 'item' && entry.item.id === latestReplyId
                  ? { ...entry, isLatestReply: true }
                  : entry,
          );
}

/**
 * The stable React key of one timeline entry.
 */
export function agentChatTimelineEntryKey(entry: AgentChatTimelineEntry): string {
    return entry.kind === 'item' ? entry.item.id : entry.id;
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
 * tools, so they are described here; every other tool goes through the shared provider tool table. A settled item that
 * did not complete names its outcome in the verb (`Failed to edit`), so the title tells the truth on its own.
 */
export function describeAgentChatWork(item: AgentChatWorkItem): AgentToolPresentation {
    const presentation = describeAgentChatWorkAction(item);
    if (item.type === 'reasoning' || item.status === 'running') return presentation;
    return { ...presentation, label: agentToolOutcomeLabel(presentation, item.status) };
}

function describeAgentChatWorkAction(item: AgentChatWorkItem): AgentToolPresentation {
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
            // expanded. A read, search, or listing already names what it looked at, so it keeps that.
            return item.description && presentation.kind === 'command'
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
                ...(first && item.changes.length === 1 && { path: first.path }),
            };
        }
    }
}

/**
 * The duration a work row shows: only once it is noticeable. A row of `<1s` labels says nothing a reader can act on.
 */
export function agentChatWorkDuration(item: AgentChatWorkItem): string | null {
    if ((item.type === 'command' || item.type === 'toolCall') && (item.durationMs ?? 0) >= 1000)
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
 * Work items that did not do what they set out to: failed, or declined by the user or a policy.
 */
const isAgentChatWorkUnsuccessful = (item: AgentChatWorkItem): boolean =>
    item.type !== 'reasoning' && (item.status === 'failed' || item.status === 'declined');

/**
 * The status glyph a summary row shows: `failed` when any item failed, else `declined` when any was declined, else
 * none.
 */
export function agentChatWorkGroupFailure(
    items: readonly AgentChatWorkItem[],
): 'declined' | 'failed' | undefined {
    const unsuccessful = items.filter((item) => isAgentChatWorkUnsuccessful(item));
    if (unsuccessful.some((item) => item.type !== 'reasoning' && item.status === 'failed'))
        return 'failed';
    return unsuccessful.length > 0 ? 'declined' : undefined;
}

/**
 * `Ran 3 commands, read 2 files` for a group, counting each changed file as one edit. Reasoning only names the group
 * when it is all the group holds. Items that failed or were declined are counted at the end (`, 1 failed`), so a
 * collapsed group never reads as a clean run.
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
    const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
    const summary = summarizeAgentToolGroup(tools);
    return failed > 0 ? `${summary}, ${failed} failed` : summary;
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
 * read file's extension, or JSON. Any other command output is painted as shell, the terminal it came from, so its
 * strings, numbers, flags, and paths still separate from the prose around them; another tool's output stays plain.
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
    if (isJsonText(output)) return 'json';
    return item.type === 'command' ? 'shell' : undefined;
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
