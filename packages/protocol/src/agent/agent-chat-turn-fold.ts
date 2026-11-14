import type { AgentChatItem, AgentChatTurn } from './agent-chat-contract.js';
import { isAgentChatItemVisible } from './agent-chat-presentation.js';
import { isAgentChatWorkItem } from './agent-chat-work.js';

/**
 * Where one fold sits in its turn. A message steered into a running turn starts a new segment, and so does a
 * compaction, so a turn the user steered twice folds into three segments. `startedAt` is when the segment's steered
 * message or compaction notice arrived and `endedAt` when the next one did; the first segment starts with the turn and
 * the last ends with it, so those bounds come from the turn instead (`agentChatFoldTiming`).
 */
export interface AgentChatTurnFoldSegment {
    index: number;
    opensTurn: boolean;
    closesTurn: boolean;
    startedAt?: number;
    endedAt?: number;
}

/**
 * One piece of a finished turn as every Chat client folds it: an item that stays in view (`kept`), or one segment's
 * work and commentary gathered behind its `Worked for` row (`fold`). A turn has at most one `fold` per segment. Every
 * part names its segment, so a client can still place the turn's outcome when the closing segment folded nothing.
 *
 * `isOpenByDefault` marks the closing fold of a turn whose final reply is a single line or missing and that kept no
 * earlier answer in view (see `foldAgentChatTurn`): such a reply ("CI passed, all done.") does not summarize the work,
 * so the work stays in view until the user folds it.
 */
export type AgentChatTurnFoldPart =
    | { kind: 'kept'; item: AgentChatItem; segment: AgentChatTurnFoldSegment }
    | {
          kind: 'fold';
          items: readonly AgentChatItem[];
          segment: AgentChatTurnFoldSegment;
          isOpenByDefault?: true;
      };

/**
 * Whether an Agent message spans several lines. A long single paragraph still counts as one line, since the source has
 * no break to measure wrapping by.
 */
function isMultiLineMessage(item: AgentChatItem | undefined): boolean {
    return item?.type === 'agentMessage' && item.text.trim().includes('\n');
}

/**
 * The answer a turn gave before its brief final reply: the closing segment's last Agent message of several lines. An
 * Agent that answered, then woke for a background task and closed with one line ("CI on main passed too."), otherwise
 * hid the answer behind the fold, leaving only the one-liner, as T3 Code keeps a superseded attempt's finished reply in
 * view.
 */
function earlierAnswerId(
    items: readonly AgentChatItem[],
    finalReplyId: string | undefined,
): string | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.id !== finalReplyId && isMultiLineMessage(item)) return item.id;
    }
    return undefined;
}

/**
 * The id of a turn's final reply: its last visible Agent message. A loop rather than `findLast`, which the phone's
 * ES2022 runtime library does not declare.
 */
export function agentChatFinalReplyId(items: readonly AgentChatItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.type === 'agentMessage' && isAgentChatItemVisible(item)) return item.id;
    }
    return undefined;
}

const NO_STEER_REPLIES: ReadonlySet<string> = new Set();

/**
 * The reasoning that opens the Agent's response to each message steered into its turn, when a tool call rather than an
 * Agent message follows it. A model sometimes answers the steer only in its thinking and goes straight back to work, so
 * that thought is the only answer the user gets: a running turn shows it expanded, and a finished turn keeps it out of
 * the fold. A reasoning run still streaming, or one followed by a reply, is left alone: the reply is the answer.
 */
export function agentChatSteerReplyThoughtIds(
    items: readonly AgentChatItem[],
): ReadonlySet<string> {
    const ids = new Set<string>();
    let pending: string[] | undefined;
    for (const item of items) {
        if (!isAgentChatItemVisible(item)) continue;
        if (item.type === 'userMessage') {
            pending = item.delivery === 'steered' ? [] : undefined;
            continue;
        }
        if (!pending) continue;
        if (item.type === 'reasoning') {
            pending.push(item.id);
            continue;
        }
        if (isAgentChatWorkItem(item)) for (const id of pending) ids.add(id);
        pending = undefined;
    }
    return ids.size === 0 ? NO_STEER_REPLIES : ids;
}

/**
 * Splits a turn's visible items where a message was steered into it or the conversation was compacted: each such item
 * after the first opens a new segment. A compaction with no work after it (one that ended the turn, or came right
 * before the final reply) stays in its segment, since splitting there would fold nothing and only cost the segment
 * before it the turn's timing and outcome. A turn with neither is one segment.
 */
function turnSegments(
    visible: readonly AgentChatItem[],
    finalReplyId: string | undefined,
): AgentChatItem[][] {
    /**
     * Whether anything foldable follows `index` before the next steered message.
     */
    const isWorkAhead = (index: number): boolean => {
        for (let next = index + 1; next < visible.length; next += 1) {
            const later = visible[next];
            if (later.type === 'userMessage') return false;
            if (later.id === finalReplyId) continue;
            if (later.type === 'notice' && later.kind !== 'retrying') continue;
            return true;
        }
        return false;
    };
    const segments: AgentChatItem[][] = [];
    for (const [index, item] of visible.entries()) {
        const current = segments.at(-1);
        const isOpener =
            index > 0 &&
            (item.type === 'userMessage' ||
                (item.type === 'notice' && item.kind === 'compacted' && isWorkAhead(index)));
        if (!current || isOpener) segments.push([item]);
        else current.push(item);
    }
    return segments;
}

/**
 * Folds a finished turn's visible items the way Codex and T3 Code end a turn. The prompt, the final reply, and the
 * notices (an error, a compaction, an answered question) stay in view; a transient retry notice, the work, and the
 * commentary before the reply fold into one part at the position of the first folded item. A turn with nothing to fold
 * comes back as `kept` parts only. Desktop and the phone share this rule so a turn folds the same on both.
 *
 * A message steered into the running turn splits it, as a steer ends a run in T3 Code: each segment folds its own work
 * and keeps its last Agent message in view as the reply to that steer. One fold for the whole turn would leave the
 * steered messages stacked together and hide every reply but the last.
 *
 * A compaction splits it the same way, so its notice stays between the work done before and after it. A long turn
 * compacted twice otherwise showed both notices back to back below one fold, reading as one compaction repeated. A
 * segment that ends at a compaction keeps no reply in view (its last Agent message is commentary, not an answer) unless
 * it holds the final reply, as when the turn compacted right after answering.
 *
 * A steer the Agent answered only in its thinking (`agentChatSteerReplyThoughtIds`) keeps that thought in view too:
 * folding it once the turn ended hid the only answer the steer got, which then read as ignored.
 *
 * A turn that ended on a one-line reply or none says little about what it did ("CI passed, all done."). Its closing
 * segment keeps its last Agent message of several lines in view as the answer (`earlierAnswerId`); without one, its
 * fold is marked `isOpenByDefault` so the work shows until the user folds it.
 *
 * `isAlsoKept` names further items a Client keeps in view; Desktop keeps the commands that created a delegation so the
 * record of delegated work survives the fold. The phone passes nothing and folds exactly as before.
 */
export function foldAgentChatTurn(
    visible: readonly AgentChatItem[],
    finalReplyId: string | undefined,
    isAlsoKept: (item: AgentChatItem) => boolean = () => false,
): AgentChatTurnFoldPart[] {
    const segments = turnSegments(visible, finalReplyId);
    const steerReplies = agentChatSteerReplyThoughtIds(visible);
    const isReplyBrief = !isMultiLineMessage(visible.find((item) => item.id === finalReplyId));
    return segments.flatMap((items, index) => {
        const isClosesTurn = index === segments.length - 1;
        const next = isClosesTurn ? undefined : segments[index + 1][0];
        const replyId = isClosesTurn
            ? finalReplyId
            : next?.type === 'userMessage'
              ? agentChatFinalReplyId(items)
              : undefined;
        const answerId =
            isClosesTurn && isReplyBrief ? earlierAnswerId(items, finalReplyId) : undefined;
        const isKept = (item: AgentChatItem): boolean =>
            item.type === 'userMessage' ||
            (answerId !== undefined && item.id === answerId) ||
            steerReplies.has(item.id) ||
            (replyId !== undefined && item.id === replyId) ||
            (finalReplyId !== undefined && item.id === finalReplyId) ||
            (item.type === 'notice' && item.kind !== 'retrying') ||
            isAlsoKept(item);
        const folded = items.filter((item) => !isKept(item));
        const segment: AgentChatTurnFoldSegment = {
            index,
            opensTurn: index === 0,
            closesTurn: isClosesTurn,
            ...(index > 0 &&
                items[0]?.createdAt !== undefined && { startedAt: items[0].createdAt }),
            ...(next?.createdAt !== undefined && { endedAt: next.createdAt }),
        };
        const parts: AgentChatTurnFoldPart[] = [];
        let hasFold = false;
        for (const item of items) {
            if (isKept(item)) {
                parts.push({ kind: 'kept', item, segment });
                continue;
            }
            if (hasFold) continue;
            hasFold = true;
            parts.push({
                kind: 'fold',
                items: folded,
                segment,
                ...(isClosesTurn &&
                    isReplyBrief &&
                    answerId === undefined && { isOpenByDefault: true as const }),
            });
        }
        return parts;
    });
}

/**
 * How long one fold's segment ran, for its `Worked for` row. A turn nobody steered or compacted keeps the turn's own
 * timing. A segment takes the turn's start or end where it opens or closes the turn, and the arrival times of the
 * steered messages and compaction notices in between; a bound the provider never recorded leaves the duration unknown,
 * so the row says `Worked` without one.
 */
export function agentChatFoldTiming(
    segment: AgentChatTurnFoldSegment,
    turn: Pick<AgentChatTurn, 'durationMs' | 'startedAt'>,
): { durationMs?: number; startedAt?: number; endedAt?: number } {
    const turnEnd =
        turn.startedAt !== undefined && turn.durationMs !== undefined
            ? turn.startedAt + turn.durationMs
            : undefined;
    if (segment.opensTurn && segment.closesTurn)
        return {
            ...(turn.durationMs !== undefined && { durationMs: turn.durationMs }),
            ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
            ...(turnEnd !== undefined && { endedAt: turnEnd }),
        };
    const startedAt = segment.opensTurn ? turn.startedAt : segment.startedAt;
    const endedAt = segment.closesTurn ? turnEnd : segment.endedAt;
    return {
        ...(startedAt !== undefined && { startedAt }),
        ...(endedAt !== undefined && { endedAt }),
        ...(startedAt !== undefined &&
            endedAt !== undefined &&
            endedAt >= startedAt && { durationMs: endedAt - startedAt }),
    };
}
