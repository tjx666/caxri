import type { AgentChatTask, AgentChatTaskPatchOperation } from '@caxri/protocol';
import {
    CaxriError,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    unwrapShellCommand,
} from '@caxri/protocol';

import { clip, isRecord, stringField, tail } from './chat-items';
import type { AgentChatSessionHost, ChatTaskHistory } from './chat-provider';
import type { ChatTaskList } from './chat-tasks';

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

interface CommandState {
    itemId: string;
    processId: string;
    command: string;
    turnId?: string;
    deltas: number;
    isBackground: boolean;
    isStopped: boolean;
}

export class CodexBackgroundTerminals {
    private readonly commands = new Map<string, CommandState>();

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
