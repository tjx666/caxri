import type { AgentChatTask, AgentChatTaskPatchOperation } from '@caxri/protocol';
import {
    CaxriError,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    unwrapShellCommand,
} from '@caxri/protocol';

import { clip, isRecord, stringField, tail } from '../../chat-items';
import type { AgentChatSessionHost, ChatTaskHistory } from '../../chat-provider';
import type { ChatTaskList } from '../../tasks/task-list';

/**
 * Background terminals of one Codex Chat. A background terminal is a unified-exec `commandExecution` (it carries a
 * `processId`) still running when its turn ends. It keeps streaming output and completes on its own;
 * `thread/backgroundTerminals/terminate` stops it. The task id is the command item id, so the timeline row and the task
 * share one key.
 */

type Json = Record<string, unknown>;
type CodexRequest = (method: string, parameters: unknown, timeoutMs?: number) => Promise<unknown>;

/**
 * Codex stops streaming one command's output after this many deltas (`MAX_EXEC_OUTPUT_DELTAS_PER_CALL` in
 * `codex-rs/core/src/exec.rs`); the shell tab then says its output is no longer live.
 */
const CODEX_MAX_OUTPUT_DELTAS = 10_000;

/**
 * Running unified-exec commands tracked for output and backgrounding.
 */
const MAX_TRACKED_COMMANDS = 200;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Pages of `thread/backgroundTerminals/list` read in one reconciliation. A list longer than this is left unreconciled
 * rather than mistaking the unread terminals for gone ones.
 */
const MAX_LIST_PAGES = 5;

/**
 * The summary of a background terminal a resumed history shows running that Caxri no longer tracks.
 */
const UNTRACKED_SUMMARY = 'Ended: Caxri restarted and can no longer track it';

interface CommandState {
    itemId: string;
    processId: string;
    command: string;
    turnId?: string;
    deltas: number;
    isBackground: boolean;
    isStopped: boolean;
}

/**
 * One `thread/backgroundTerminals/list` entry as an item id and its terminal, or nothing for a malformed entry.
 */
function listedTerminal(entry: unknown): Array<[string, { processId: string; command: string }]> {
    if (!isRecord(entry)) return [];
    const itemId = stringField(entry.itemId);
    const processId = stringField(entry.processId);
    if (!itemId || !processId) return [];
    const command = typeof entry.command === 'string' ? entry.command : '';
    return [[clip(itemId, 200), { processId, command }]];
}

/**
 * A history item that was still running when its turn finished: a unified-exec command that outlived the turn.
 */
function isUnfinishedTerminal(raw: unknown): raw is Json {
    return (
        isRecord(raw) &&
        raw.type === 'commandExecution' &&
        raw.status === 'inProgress' &&
        Boolean(stringField(raw.id)) &&
        Boolean(stringField(raw.processId))
    );
}

/**
 * The terminals `thread/backgroundTerminals/list` reports, keyed by item id, or `undefined` when the list could not be
 * read completely (an older Codex without the method, an error, or more pages than {@link MAX_LIST_PAGES}).
 */
async function listTerminals(
    request: CodexRequest,
    threadId: string,
): Promise<Map<string, { processId: string; command: string }> | undefined> {
    const listed = new Map<string, { processId: string; command: string }>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        let result: unknown;
        try {
            // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
            result = await request(
                'thread/backgroundTerminals/list',
                { threadId, ...(cursor && { cursor }) },
                REQUEST_TIMEOUT_MS,
            );
        } catch {
            return undefined;
        }
        if (!isRecord(result) || !Array.isArray(result.data)) return undefined;
        for (const [itemId, terminal] of result.data.flatMap(listedTerminal))
            listed.set(itemId, terminal);
        cursor = stringField(result.nextCursor);
        if (!cursor) return listed;
    }
    return undefined;
}

export class CodexBackgroundTerminals {
    private readonly commands = new Map<string, CommandState>();

    private reconciling: Promise<void> | undefined;

    /**
     * Counts {@link reconcile} calls. A call made while a read is in flight may need a newer answer than that read gives
     * (a terminal Codex reaped during the turn that just ended), so a changed count means one more read.
     */
    private reconcileRequests = 0;

    /**
     * Commands that completed while the current list read was in flight. The answer may still list them, since Codex
     * answered before it completed them; adopting one would list a finished terminal as running again.
     */
    private endedDuringRead: Set<string> | undefined;

    constructor(
        private readonly host: Pick<AgentChatSessionHost, 'applyTask' | 'read'>,
        private readonly list: ChatTaskList,
        private readonly options: {
            request: CodexRequest;
            threadId: () => string | undefined;
        },
    ) {}

    private applyTask(taskId: string, operations: AgentChatTaskPatchOperation[]): void {
        if (operations.length > 0) this.host.applyTask(taskId, operations);
    }

    /**
     * Lists `itemId` as a running background terminal, with the output its timeline row already holds.
     */
    private adopt(itemId: string, processId: string, command: string): void {
        const item = this.host.read().items.find((candidate) => candidate.id === itemId);
        this.commands.set(itemId, {
            itemId,
            processId,
            command,
            ...(item?.turnId && { turnId: item.turnId }),
            deltas: 0,
            isBackground: true,
            isStopped: false,
        });
        const previous = this.list.get(itemId);
        this.list.upsert(itemId, {
            kind: 'shell',
            title: clip(unwrapShellCommand(command), 1_000) || 'Background terminal',
            itemId,
            status: 'running',
            isBackground: true,
            canStop: true,
            // A terminal replayed as untracked is tracked again; an empty summary hides that note.
            ...(previous?.summary === UNTRACKED_SUMMARY && { summary: '' }),
        });
        this.applyTask(itemId, [
            { op: 'state', state: { output: item?.type === 'command' ? item.output : '' } },
        ]);
    }

    private async reconcileUntilCurrent(): Promise<void> {
        try {
            let answered: number;
            do {
                answered = this.reconcileRequests;
                // eslint-disable-next-line no-await-in-loop -- each read must see the result of the one before it
                await this.readAndReconcile();
            } while (answered !== this.reconcileRequests);
        } finally {
            this.reconciling = undefined;
        }
    }

    private async readAndReconcile(): Promise<void> {
        const threadId = this.options.threadId();
        if (!threadId) return;
        // Only a terminal already in the background when the list was requested can be missing from it; one a turn
        // moves there while the request is in flight is not gone.
        const known = new Set(
            this.commands
                .values()
                .filter((state) => state.isBackground)
                .map((state) => state.itemId),
        );
        const ended = new Set<string>();
        this.endedDuringRead = ended;
        let listed: Awaited<ReturnType<typeof listTerminals>>;
        try {
            listed = await listTerminals(this.options.request, threadId);
        } finally {
            this.endedDuringRead = undefined;
        }
        if (!listed) return;
        const gone = this.commands
            .values()
            .filter((state) => known.has(state.itemId) && !listed.has(state.itemId))
            .toArray();
        for (const state of gone) {
            this.commands.delete(state.itemId);
            if (this.list.get(state.itemId)?.status === 'running')
                this.list.upsert(state.itemId, { status: 'stopped' });
        }
        const { activeTurnId, items } = this.host.read();
        const turnOf = new Map(items.map((item) => [item.id, item.turnId]));
        for (const [itemId, terminal] of listed) {
            if (this.commands.has(itemId) || ended.has(itemId)) continue;
            if (activeTurnId && turnOf.get(itemId) === activeTurnId) continue;
            this.adopt(itemId, terminal.processId, terminal.command);
        }
    }

    /**
     * A `commandExecution` item of the Chat's own thread. Unified-exec commands (with a `processId`) are tracked so one
     * still running when its turn ends becomes a background terminal; its completion settles the task.
     */
    onItem(raw: Json, turnId: string | undefined, isStarted: boolean): void {
        const itemId = stringField(raw.id);
        if (!itemId) return;
        const id = clip(itemId, 200);
        const state = this.commands.get(id);
        if (raw.status === 'inProgress' || (isStarted && raw.status === undefined)) {
            const processId = stringField(raw.processId);
            if (state || !processId) return;
            this.commands.set(id, {
                itemId: id,
                processId,
                command: typeof raw.command === 'string' ? raw.command : '',
                ...(turnId && { turnId: clip(turnId, 200) }),
                deltas: 0,
                isBackground: false,
                isStopped: false,
            });
            for (const [key, candidate] of this.commands) {
                if (this.commands.size <= MAX_TRACKED_COMMANDS) break;
                if (!candidate.isBackground) this.commands.delete(key);
            }
            return;
        }
        if (!state) return;
        this.commands.delete(id);
        this.endedDuringRead?.add(id);
        if (!state.isBackground) return;
        const output = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : undefined;
        if (output)
            this.applyTask(id, [
                { op: 'state', state: { output: tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH) } },
            ]);
        let status: AgentChatTask['status'] = raw.status === 'completed' ? 'completed' : 'failed';
        if (state.isStopped) status = 'stopped';
        const durationMs =
            typeof raw.durationMs === 'number' && raw.durationMs >= 0 ? raw.durationMs : undefined;
        this.list.upsert(id, {
            status,
            ...(durationMs !== undefined && { usage: { durationMs } }),
        });
    }

    /**
     * `item/commandExecution/outputDelta` of the Chat's own thread, mirrored into a background terminal's output.
     */
    onOutput(itemId: unknown, delta: unknown): void {
        if (typeof itemId !== 'string' || typeof delta !== 'string') return;
        const state = this.commands.get(clip(itemId, 200));
        if (!state) return;
        state.deltas += 1;
        if (!state.isBackground) return;
        const operations: AgentChatTaskPatchOperation[] = [];
        if (delta)
            operations.push({ op: 'appendOutput', delta: clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH) });
        if (state.deltas === CODEX_MAX_OUTPUT_DELTAS)
            operations.push({ op: 'state', state: { isOutputCapped: true } });
        this.applyTask(state.itemId, operations);
    }

    /**
     * The Chat's turn ended: every unified-exec command of that turn still running is a background terminal now.
     * Returns their item ids so the timeline keeps those rows running instead of closing them as interrupted.
     */
    onTurnFinished(turnId: string): ReadonlySet<string> {
        const kept = new Set<string>();
        const items = new Map(this.host.read().items.map((item) => [item.id, item]));
        for (const state of this.commands.values()) {
            if (state.turnId !== turnId || state.isBackground) continue;
            state.isBackground = true;
            kept.add(state.itemId);
            this.list.upsert(state.itemId, {
                kind: 'shell',
                title: clip(unwrapShellCommand(state.command), 1_000) || 'Background terminal',
                itemId: state.itemId,
                status: 'running',
                isBackground: true,
                canStop: true,
            });
            const item = items.get(state.itemId);
            const output = item?.type === 'command' ? item.output : '';
            this.applyTask(state.itemId, [
                {
                    op: 'state',
                    state: {
                        output,
                        ...(state.deltas >= CODEX_MAX_OUTPUT_DELTAS && { isOutputCapped: true }),
                    },
                },
            ]);
        }
        return kept;
    }

    /**
     * Lists the background terminals a resumed thread's history still shows running (#1610): unified-exec commands left
     * `inProgress` in a turn that finished. The process that ran them is gone, so each is listed stopped and says why;
     * a terminal Codex still lists is taken back running by {@link reconcile}, which runs once the thread opens.
     */
    replay(turns: readonly unknown[]): void {
        const unfinished = turns.flatMap((turn) =>
            isRecord(turn) && turn.status !== 'inProgress' && Array.isArray(turn.items)
                ? turn.items.filter(isUnfinishedTerminal)
                : [],
        );
        for (const raw of unfinished) {
            const id = clip(stringField(raw.id) ?? '', 200);
            if (this.list.get(id)) continue;
            const command = typeof raw.command === 'string' ? raw.command : '';
            this.list.upsert(id, {
                kind: 'shell',
                title: clip(unwrapShellCommand(command), 1_000) || 'Background terminal',
                itemId: id,
                status: 'stopped',
                isBackground: true,
                canStop: false,
                summary: UNTRACKED_SUMMARY,
            });
        }
    }

    /**
     * Brings the background terminals in line with Codex's own list (#1612). The list is otherwise derived from
     * notifications alone, so a missed completion would leave a terminal running forever and a terminal Caxri never saw
     * end its turn would stay invisible. A terminal Codex no longer lists is stopped; one Codex lists that Caxri does
     * not track is added, unless it belongs to the turn still running (it becomes a background terminal when that turn
     * ends). A call while a read is in flight is answered by one more read after it (#1722): the read in flight may
     * predate what the caller saw end, and joining it alone would leave a reaped terminal running. Every call made
     * during one read shares that next read; an unreadable list changes nothing.
     */
    reconcile(): Promise<void> {
        this.reconcileRequests += 1;
        this.reconciling ??= this.reconcileUntilCurrent();
        return this.reconciling;
    }

    /**
     * Terminates a background terminal. A request error propagates for the caller to map.
     */
    async stop(taskId: string): Promise<void> {
        const state = this.commands.get(taskId);
        const threadId = this.options.threadId();
        if (!state || !threadId) throw new CaxriError('CONFLICT', 'This task is no longer running');
        const result = await this.options.request(
            'thread/backgroundTerminals/terminate',
            { threadId, processId: state.processId },
            REQUEST_TIMEOUT_MS,
        );
        if (!isRecord(result) || result.terminated !== true)
            throw new CaxriError('CONFLICT', 'This task is no longer running');
        state.isStopped = true;
        this.list.upsert(taskId, { status: 'stopped' });
    }

    /**
     * A terminal's projection rebuilt from its timeline row, which holds the output Codex streamed.
     */
    history(taskId: string): ChatTaskHistory {
        const item = this.host.read().items.find((candidate) => candidate.id === taskId);
        return {
            taskId,
            operations: [
                { op: 'state', state: { output: item?.type === 'command' ? item.output : '' } },
            ],
        };
    }

    /**
     * The provider process ended and took every terminal with it.
     */
    clear(): void {
        this.commands.clear();
    }
}
