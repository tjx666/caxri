import type {
    AgentChatGoal,
    AgentChatImageInput,
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatPlan,
    AgentChatTaskPatchOperation,
    AgentChatTurn,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { extractVisibleTranscriptMessage } from '../../agents';
import {
    clip,
    closeDanglingItem,
    isRecord,
    storedChatImageSchema,
    stringField,
} from '../chat-items';
import { claudeFeedbackItems, claudeFeedbackToolUseId } from '../feedback/claude-feedback';
import type { ClaudeGoalOutcome } from '../goals/claude-goals';
import { claudeGoalNotice, claudeGoalOutcome, endedClaudeGoal } from '../goals/claude-goals';
import { claudeResponseUsage } from '../providers/claude/context';
import {
    claudeUserImageCount,
    isClaudeCompactCommand,
    isClaudeUsageLimitContinuePrompt,
    isHumanQueuedClaudePrompt,
    isQueuedClaudePrompt,
} from '../providers/claude/input';
import {
    claudeAssistantItems,
    ClaudeBlockIds,
    claudeUsageTokens,
    text,
} from '../providers/claude/items';
import { claudeCompaction } from '../providers/claude/system-notices';
import { settleClaudeToolItem } from '../providers/claude/tool-results';
import { ClaudeTurnClock } from './claude-turn-clock';

/**
 * Rebuilds a resumed Claude Code Chat from its session JSONL transcript. Claude Code's resume returns no history, so
 * the transcript tail is the only record of earlier turns. Inputs are untrusted JSON.
 */

type Json = Record<string, unknown>;

interface HistoryState {
    /**
     * Reads a subagent's own transcript, whose records are all sidechain records.
     */
    isSidechain: boolean;
    ids: ClaudeBlockIds;
    turns: AgentChatTurn[];
    items: Map<string, AgentChatItem>;
    turnId?: string;
    plan?: AgentChatPlan;
    /**
     * The newest main-thread response that reported usage, and when it arrived. A compaction after it clears it: the
     * context it measured, and the prompt cache written for it, are gone.
     */
    lastResponse?: { message: Json; at: number };
    /**
     * The goal the transcript leaves, and the index of the first turn opened after it was set: its time is the sum of
     * those turns' durations. `outcome` is set once Claude Code settled it.
     */
    goal?: { objective: string; sinceTurn: number; outcome?: ClaudeGoalOutcome };
    turnClock: ClaudeTurnClock;
}

/**
 * Keeps the active goal across a goal record: a new objective, or the same one set again after it ended, starts its own
 * time; the same active one keeps it.
 */
function setHistoryGoal(state: HistoryState, condition: string | undefined): void {
    const objective = clip(condition?.trim() ?? '', MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH);
    if (!objective) delete state.goal;
    else if (state.goal?.objective !== objective || state.goal.outcome)
        state.goal = { objective, sinceTurn: state.turns.length };
}

/**
 * Claude Code writes the goal's state to the transcript only, as `goal_status` attachments (verified with Claude Code
 * 2.1.310): `met: false` when the goal is set (`sentinel`) and after each check that found it unmet (`reason`), and
 * `met: true` or `failed: true` once it ends. An ended goal keeps its row with the outcome, as the live Chat does.
 */
function applyGoalStatus(state: HistoryState, attachment: Json): void {
    const outcome = claudeGoalOutcome(attachment);
    if (!outcome) {
        setHistoryGoal(state, stringField(attachment.condition));
        return;
    }
    const objective = outcome.objective || state.goal?.objective;
    if (!objective) return;
    state.goal = {
        objective,
        sinceTurn: state.goal?.sinceTurn ?? state.turns.length,
        outcome,
    };
}

/**
 * Reads the `/goal` replies and the error warning among replayed notices, as the live Chat does.
 */
function applyGoalNotices(state: HistoryState, notices: readonly AgentChatItem[]): void {
    for (const notice of notices) {
        if (notice.type !== 'notice') continue;
        const reply = claudeGoalNotice(notice);
        if (reply === null) delete state.goal;
        else if (reply) setHistoryGoal(state, reply.objective);
    }
}

/**
 * The goal row for a replayed transcript's last goal, active or ended. Claude Code has no Pause, and reports tokens
 * only once the goal ends.
 */
function historyGoal(state: HistoryState, now: number): AgentChatGoal | undefined {
    if (!state.goal) return undefined;
    const workedMs = state.turns
        .slice(state.goal.sinceTurn)
        .reduce((total, turn) => total + (turn.durationMs ?? 0), 0);
    const goal = { objective: state.goal.objective, timeUsedSeconds: Math.round(workedMs / 1000) };
    if (state.goal.outcome) return endedClaudeGoal(goal, state.goal.outcome, now);
    return {
        objective: state.goal.objective,
        status: 'active',
        tokensUsed: 0,
        timeUsedSeconds: Math.round(workedMs / 1000),
        updatedAt: now,
        pausable: false,
    };
}

function parseRecord(line: string): Json | undefined {
    if (!line.trim()) return undefined;
    try {
        const record: unknown = JSON.parse(line);
        return isRecord(record) ? record : undefined;
    } catch {
        return undefined;
    }
}

function applySystemRecord(state: HistoryState, record: Json): void {
    const { turnId } = state;
    if (record.subtype === 'compact_boundary') {
        delete state.lastResponse;
        const id = clip(`compact:${text(record.uuid)}`, 200);
        const compaction = claudeCompaction(record);
        state.items.set(id, {
            id,
            ...(turnId && { turnId }),
            type: 'notice',
            kind: 'compacted',
            ...(compaction && { compaction }),
            // A compaction bounds the fold segments around it, so a replayed one keeps its time for their durations.
            ...recordTime(record),
        });
        return;
    }
    if (record.subtype !== 'turn_duration') {
        const toolUseId = claudeFeedbackToolUseId(record);
        // Claude also writes synthetic tool ids for session Hooks. A sidechain or known item proves Agent ownership.
        const scope =
            state.isSidechain || (toolUseId && state.items.has(toolUseId)) ? 'agent' : 'session';
        const feedbackItems = claudeFeedbackItems(record, undefined, scope);
        for (const item of feedbackItems)
            state.items.set(item.id, { ...item, ...recordTime(record) });
        applyGoalNotices(state, feedbackItems);
        return;
    }
    const current = state.turns.at(-1);
    const { durationMs } = record;
    if (current && typeof durationMs === 'number' && durationMs >= 0)
        current.durationMs = durationMs;
}

function applyUserRecord(state: HistoryState, record: Json, message: Json): void {
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    for (const block of blocks) {
        const toolUseId = block.type === 'tool_result' ? stringField(block.tool_use_id) : undefined;
        const item = toolUseId ? state.items.get(clip(toolUseId, 200)) : undefined;
        const settled =
            item && settleClaudeToolItem(item, block, { structured: record.toolUseResult });
        if (settled) state.items.set(settled.id, settled);
    }
    if (record.isCompactSummary === true) return;
    // The shared extractor ignores sidechain records; a subagent transcript consists of nothing else.
    const visible = extractVisibleTranscriptMessage(
        state.isSidechain ? { ...record, isSidechain: false } : record,
    );
    const uuid = stringField(record.uuid);
    // An image-only message has no visible text but is still the user's turn.
    const imageCount = claudeUserImageCount(message.content);
    if (!uuid || (imageCount === 0 && visible?.role !== 'user')) return;
    const turnId = clip(uuid, 200);
    state.turnId = turnId;
    state.turns.push({ id: turnId, status: 'completed' });
    // The compaction notice already stands for `/compact`, and the usage-limit notice for an automatic continuation;
    // the live Chat hides their bubbles too.
    if (imageCount === 0 && visible && isClaudeCompactCommand(visible.text)) return;
    if (isClaudeUsageLimitContinuePrompt(uuid)) return;
    state.items.set(turnId, {
        id: turnId,
        turnId,
        type: 'userMessage',
        text: clip(visible?.text ?? '', MAX_AGENT_CHAT_TEXT_LENGTH),
        ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
        ...(isQueuedClaudePrompt(uuid) && { delivery: 'queued' as const }),
        ...recordTime(record),
    });
}

/**
 * The ISO `timestamp` Claude Code writes on every transcript record, as an item's `createdAt`. A record without a
 * readable one leaves the item undated rather than dated by the resume.
 */
function recordTime(record: Json): { createdAt?: number } {
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    return Number.isFinite(time) && time >= 0 ? { createdAt: time } : {};
}

/**
 * A message steered into a running turn. Claude Code records the prompt it folds in mid-turn as a `queued_command`
 * attachment keyed by the sent uuid (`source_uuid`), not as a user record (verified with Claude Code 2.1.296).
 */
function applySteeredRecord(state: HistoryState, attachment: Json, record: Json): void {
    const uuid = stringField(attachment.source_uuid);
    if (!uuid || !state.turnId) return;
    if (!isHumanQueuedClaudePrompt(attachment)) return;
    const { prompt } = attachment;
    const blocks = Array.isArray(prompt) ? prompt.filter(isRecord) : [];
    const promptText =
        typeof prompt === 'string'
            ? prompt
            : blocks.flatMap((block) => (block.type === 'text' ? [text(block.text)] : [])).join('');
    const imageCount = claudeUserImageCount(blocks);
    if (!promptText && imageCount === 0) return;
    const id = clip(uuid, 200);
    state.items.set(id, {
        id,
        turnId: state.turnId,
        type: 'userMessage',
        text: clip(promptText, MAX_AGENT_CHAT_TEXT_LENGTH),
        ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
        delivery: 'steered',
        ...recordTime(record),
    });
}

function applyHistoryRecord(state: HistoryState, record: Json): void {
    if (record.isSidechain === true && !state.isSidechain) return;
    if (
        record.type === 'attachment' &&
        isRecord(record.attachment) &&
        record.attachment.type === 'queued_command'
    ) {
        applySteeredRecord(state, record.attachment, record);
        return;
    }
    if (
        record.type === 'attachment' &&
        isRecord(record.attachment) &&
        record.attachment.type === 'goal_status'
    ) {
        applyGoalStatus(state, record.attachment);
        return;
    }
    if (record.type === 'attachment') {
        const toolUseId = claudeFeedbackToolUseId(record);
        // An unknown id is not ownership evidence: Stop and UserPromptSubmit Hooks use generated ids too.
        const scope =
            state.isSidechain || (toolUseId && state.items.has(toolUseId)) ? 'agent' : 'session';
        const feedback = claudeFeedbackItems(
            record,
            record.parentUuid == null ? undefined : state.turnId,
            scope,
        );
        for (const item of feedback) state.items.set(item.id, { ...item, ...recordTime(record) });
        applyGoalNotices(state, feedback);
        return;
    }
    if (record.isMeta === true) return;
    if (record.type === 'system') {
        applySystemRecord(state, record);
        return;
    }
    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) return;
    if (record.type === 'assistant') {
        const feedback = claudeFeedbackItems(
            record,
            record.parentUuid == null ? undefined : state.turnId,
            state.isSidechain ? 'agent' : 'session',
        );
        if (feedback.length > 0) {
            for (const item of feedback)
                state.items.set(item.id, { ...item, ...recordTime(record) });
            applyGoalNotices(state, feedback);
            return;
        }
        const mapped = claudeAssistantItems(message, state.turnId, state.ids);
        const time = recordTime(record);
        if (
            !state.isSidechain &&
            record.isSidechain !== true &&
            time.createdAt !== undefined &&
            (claudeUsageTokens(message.usage) ?? 0) > 0
        )
            state.lastResponse = { message, at: time.createdAt };
        for (const item of mapped.items) {
            // A streamed reply spans several records; the first one is when it began.
            const createdAt = state.items.get(item.id)?.createdAt ?? time.createdAt;
            state.items.set(item.id, createdAt === undefined ? item : { ...item, createdAt });
        }
        if (mapped.plan) state.plan = mapped.plan;
    } else if (record.type === 'user') applyUserRecord(state, record, message);
}

/**
 * Whether a record is a prompt the user typed, which opens a turn: a visible user message or one carrying images, and
 * not a tool result.
 */
function isUserPrompt(record: Json | undefined): boolean {
    if (record?.type !== 'user' || record.isMeta === true || record.isSidechain === true)
        return false;
    const message = isRecord(record.message) ? record.message : undefined;
    const blocks = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
    if (blocks.some((block) => block.type === 'tool_result')) return false;
    return (
        extractVisibleTranscriptMessage(record)?.role === 'user' ||
        claudeUserImageCount(message?.content) > 0
    );
}

function parentOf(record: Json): string | undefined {
    return stringField(record.parentUuid) ?? stringField(record.logicalParentUuid);
}

/**
 * Records a rewind left behind. Claude Code's transcript is append-only and each record names its `parentUuid`, so a
 * conversation resumed at an earlier point (`resumeSessionAt`, its own `/rewind`) continues from there and leaves the
 * old continuation in the file. The active branch runs from the newest main-thread record (or from `resumeAt`, the
 * point a restart resumes at before anything new was written) back through its parents. A fork is only treated as a
 * rewind where the active branch continues with a new user prompt: parallel tool calls also branch (each tool result
 * hangs off its own `tool_use` record), and those siblings stay.
 */
function abandonedRecordIds(records: readonly Json[], resumeAt: string | undefined): Set<string> {
    const byId = new Map<string, Json>();
    const children = new Map<string, string[]>();
    let newest: string | undefined;
    for (const record of records) {
        const uuid = stringField(record.uuid);
        if (!uuid) continue;
        byId.set(uuid, record);
        const parent = stringField(record.parentUuid);
        if (parent) children.set(parent, [...(children.get(parent) ?? []), uuid]);
        if (
            record.isSidechain !== true &&
            ['user', 'assistant', 'system'].includes(String(record.type))
        )
            newest = uuid;
    }
    const abandoned = new Set<string>();
    const abandon = (root: string): void => {
        const stack = [root];
        for (let uuid = stack.pop(); uuid !== undefined; uuid = stack.pop()) {
            if (abandoned.has(uuid)) continue;
            abandoned.add(uuid);
            stack.push(...(children.get(uuid) ?? []));
        }
    };
    const leaf = resumeAt !== undefined && byId.has(resumeAt) ? resumeAt : newest;
    if (leaf === undefined) return abandoned;
    const resumedChildren = leaf === resumeAt ? (children.get(leaf) ?? []) : [];
    for (const child of resumedChildren) abandon(child);
    const branch = new Set<string>();
    for (let uuid: string | undefined = leaf; uuid !== undefined && !branch.has(uuid);) {
        branch.add(uuid);
        const record = byId.get(uuid);
        uuid = record && parentOf(record);
    }
    for (const uuid of branch) {
        const next = children.get(uuid)?.find((child) => branch.has(child));
        if (next === undefined || !isUserPrompt(byId.get(next))) continue;
        const siblings = children.get(uuid) ?? [];
        for (const child of siblings) if (child !== next) abandon(child);
    }
    return abandoned;
}

function readHistory(transcript: string, isSidechain: boolean, resumeAt?: string): HistoryState {
    const state: HistoryState = {
        isSidechain,
        ids: new ClaudeBlockIds(),
        turns: [],
        items: new Map(),
        turnClock: new ClaudeTurnClock(),
    };
    const records = transcript
        .split('\n')
        .map(parseRecord)
        .filter((record) => record !== undefined);
    const abandoned = isSidechain ? new Set<string>() : abandonedRecordIds(records, resumeAt);
    for (const record of records) {
        const uuid = stringField(record.uuid);
        if (uuid !== undefined && abandoned.has(uuid)) continue;
        const turnCount = state.turns.length;
        applyHistoryRecord(state, record);
        if (record.isSidechain !== true || state.isSidechain)
            state.turnClock.tick(
                record,
                recordTime(record).createdAt,
                state.turns.length > turnCount ? state.turns.at(-1) : undefined,
            );
    }
    state.turnClock.settle();
    return state;
}

/**
 * Where a restart resumes so the conversation ends right before user message `itemId`: the nearest earlier user or
 * assistant record on its branch, which `resumeSessionAt` accepts. `fresh` when the message opened the conversation,
 * and `undefined` when the transcript tail no longer holds it.
 */
export function claudeRewindPoint(
    transcript: string,
    itemId: string,
): { kind: 'resumeAt'; at: string } | { kind: 'fresh' } | undefined {
    const byId = new Map<string, Json>();
    for (const line of transcript.split('\n')) {
        const record = parseRecord(line);
        const uuid = record && stringField(record.uuid);
        if (record && uuid) byId.set(uuid, record);
    }
    const message = byId.get(itemId);
    if (!message) return undefined;
    const seen = new Set<string>();
    for (let uuid = parentOf(message); uuid !== undefined && !seen.has(uuid);) {
        seen.add(uuid);
        const record = byId.get(uuid);
        // The tail ends before the conversation does; an earlier record exists but is out of reach.
        if (!record) return undefined;
        if (record.isSidechain !== true && (record.type === 'user' || record.type === 'assistant'))
            return { kind: 'resumeAt', at: uuid };
        uuid = parentOf(record);
    }
    return { kind: 'fresh' };
}

/**
 * Operations that replace the projection with a resumed Claude Code session, read from the tail of its JSONL
 * transcript. Sidechains (subagents), injected harness records, and branches a rewind left behind are skipped; a
 * visible user prompt opens a turn. The whole tail is replayed: what the projection's budget evicts stays in Server
 * Core's history archive, and `truncated` marks a tail that stops short of the transcript's start. Every resumed turn
 * is finished: a resume never re-enters a turn the previous process was running. `resumeAt` ends the history at that
 * record, for the restart right after a rewind. The transcript's last goal, active or ended with its outcome, comes
 * back as the snapshot's `goal`, since Claude Code streams no goal state of its own.
 */
export function claudeHistoryOperations(
    transcript: string,
    isTailTruncated: boolean,
    resumeAt?: string,
    now = Date.now(),
): AgentChatPatchOperation[] {
    const state = readHistory(transcript, false, resumeAt);
    const goal = historyGoal(state, now);
    const { turns, items, plan, lastResponse } = state;
    // A resumed Chat reports no usage until its next reply, so the composer's cache notice would stay hidden exactly
    // when it matters most: reopening a conversation whose prompt cache expired while it sat idle.
    const usage =
        lastResponse && claudeResponseUsage(lastResponse.message, {}, undefined, lastResponse.at);
    const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
    for (const item of items.values())
        operations.push({ op: 'upsertItem', item: closeDanglingItem(item) ?? item });
    operations.push({
        op: 'state',
        state: {
            turns,
            activeTurnId: null,
            ...(isTailTruncated && { truncated: true }),
            ...(plan && { plan }),
            ...(usage && { usage }),
            ...(goal && { goal }),
        },
    });
    return operations;
}

/**
 * Every item and turn of a Claude Code session's main conversation, oldest first, for paging back through history the
 * projection no longer holds. Each turn is finished, as in {@link claudeHistoryOperations}.
 */
export function claudeHistoryItems(transcript: string): {
    items: AgentChatItem[];
    turns: AgentChatTurn[];
} {
    const { turns, items } = readHistory(transcript, false);
    return {
        items: items
            .values()
            .map((item) => closeDanglingItem(item) ?? item)
            .toArray(),
        turns,
    };
}

/**
 * Operations that rebuild one subagent's task projection from its own JSONL transcript (Claude Code writes it beside
 * the session transcript). The subagent's prompt opens it as a user message; turn ids are dropped because a task
 * projection has no turns. Every item is replayed: the task projection keeps the newest `MAX_AGENT_CHAT_TASK_ITEMS` and
 * archives the rest for `agentChat.readHistory`.
 */
export function claudeTaskHistoryOperations(
    transcript: string,
    isTailTruncated: boolean,
): AgentChatTaskPatchOperation[] {
    const { items } = readHistory(transcript, true);
    const all = items
        .values()
        .map((item): AgentChatItem => {
            const settled = closeDanglingItem(item) ?? item;
            return Object.fromEntries(
                Object.entries(settled).filter(([key]) => key !== 'turnId'),
            ) as AgentChatItem;
        })
        .toArray();
    return [
        { op: 'reset' },
        ...all.map((item) => ({ op: 'upsertItem' as const, item })),
        ...(isTailTruncated ? [{ op: 'state' as const, state: { truncated: true } }] : []),
    ];
}

/**
 * The content blocks of the user message `itemId` names: a user record's `uuid` (the id `applyUserRecord` gives it) or
 * a steered prompt's `source_uuid` (the id `applySteeredRecord` gives it).
 */
function userMessageBlocks(record: Json, itemId: string): Json[] | undefined {
    if (record.type === 'user' && stringField(record.uuid) === itemId) {
        const message = isRecord(record.message) ? record.message : undefined;
        return Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
    }
    const attachment = isRecord(record.attachment) ? record.attachment : undefined;
    if (
        record.type === 'attachment' &&
        attachment?.type === 'queued_command' &&
        stringField(attachment.source_uuid) === itemId
    )
        return Array.isArray(attachment.prompt) ? attachment.prompt.filter(isRecord) : [];
    return undefined;
}

/**
 * The `index`th image of the user message `itemId` names, as the transcript stores it; `undefined` when the transcript
 * holds no such message, and `null` when the message has no readable image there. Only a line naming the id is parsed,
 * so finding one message does not decode every image in the transcript.
 */
export function claudeHistoryImage(
    transcript: string,
    itemId: string,
    index: number,
): Omit<AgentChatImageInput, 'thumbnail'> | null | undefined {
    for (const line of transcript.split('\n')) {
        if (!line.includes(itemId)) continue;
        const record = parseRecord(line);
        const blocks = record && userMessageBlocks(record, itemId);
        if (!blocks) continue;
        const images = blocks.filter((block) => block.type === 'image');
        const source: unknown = (images[index] as Json | undefined)?.source;
        if (!isRecord(source) || source.type !== 'base64') return null;
        const parsed = storedChatImageSchema.safeParse({
            mediaType: source.media_type,
            data: source.data,
        });
        return parsed.success ? parsed.data : null;
    }
    return undefined;
}
