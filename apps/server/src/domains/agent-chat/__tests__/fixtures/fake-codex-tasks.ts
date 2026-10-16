/**
 * Background-work scenarios for the fake Codex app-server (`fake-codex-app-server.ts`): subagents whose child threads
 * stream on the same connection, unified-exec background terminals with `thread/backgroundTerminals/*`, the compaction
 * turn, and `thread/read`. Kept apart so the app-server stand-in stays readable.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeThread, FakeTurn } from './fake-codex-io.ts';
import { runBrowserStep } from './fake-codex-mcp-calls.ts';

interface FakeTerminal {
    itemId: string;
    processId: string;
    command: string;
    output: string;
    turn: FakeTurn;
    timer?: NodeJS.Timeout;
}

/**
 * Mutable scenario state, kept on one object so handlers update it without reassigning module bindings.
 */
const tasks = {
    nextProcessId: 4000,
    children: new Map<string, FakeThread>(),
    childTurns: new Map<string, FakeTurn>(),
    terminals: new Map<string, FakeTerminal>(),
};

/**
 * A child thread's turn, started the way Codex runs a spawned agent: its own `turn/started`, its prompt as the user
 * message, and its work, all on the child's `threadId`.
 */
function beginChildTurn(io: FakeCodexIo, child: FakeThread, prompt: string): FakeTurn {
    const turn: FakeTurn = {
        id: crypto.randomUUID(),
        threadId: child.id,
        items: [],
        status: 'inProgress',
        error: null,
        startedAt: Date.now(),
    };
    child.turns.push(turn);
    tasks.childTurns.set(child.id, turn);
    io.notifyTurn(turn, 'turn/started', { turn: { id: turn.id, items: [], status: 'inProgress' } });
    const user = {
        type: 'userMessage',
        id: crypto.randomUUID(),
        clientId: null,
        content: [{ type: 'text', text: prompt, text_elements: [] }],
    };
    io.startItem(turn, user);
    io.completeItem(turn, user);
    return turn;
}

function finishChildTurn(io: FakeCodexIo, child: FakeThread, turn: FakeTurn) {
    if (turn.finished) return;
    turn.finished = true;
    turn.status = turn.interrupted
        ? 'interrupted'
        : turn.status === 'failed'
          ? 'failed'
          : 'completed';
    turn.durationMs = Date.now() - turn.startedAt;
    tasks.childTurns.delete(child.id);
    io.save(child);
    io.notifyTurn(turn, 'turn/completed', { turn: { ...io.wireTurn(turn), items: [] } });
    turn.onFinished?.();
}

/**
 * `isHeld` keeps the child working after the parent turn ends; `isBrowsing` has the child run the `browsestep` Computer
 * Use steps before it reports.
 */
export async function runSubagent(
    io: FakeCodexIo,
    turn: FakeTurn,
    {
        isHeld,
        isBrowsing,
        needsApproval,
        fails,
    }: { isHeld: boolean; isBrowsing: boolean; needsApproval: boolean; fails?: boolean },
) {
    const parent = io.currentThread();
    const child: FakeThread = { id: crypto.randomUUID(), turns: [], parentThreadId: parent.id };
    tasks.children.set(child.id, child);
    const prompt = 'Inspect the fixtures\nand report what you find.';
    const spawn = {
        type: 'collabAgentToolCall',
        id: crypto.randomUUID(),
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: parent.id,
        receiverThreadIds: [] as string[],
        prompt,
        model: 'fake-codex-mini',
        reasoningEffort: null,
        agentsStates: {},
    };
    io.startItem(turn, { ...spawn });
    // The child starts working before the spawn call reports which thread it created.
    const childTurn = beginChildTurn(io, child, prompt);
    io.completeItem(childTurn, {
        type: 'reasoning',
        id: crypto.randomUUID(),
        summary: ['Looking at the fixtures.'],
        content: [],
    });
    io.completeItem(turn, {
        ...spawn,
        status: 'completed',
        receiverThreadIds: [child.id],
        agentsStates: { [child.id]: { status: 'pendingInit', message: null } },
    });
    io.completeItem(childTurn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "ls fixtures"',
        cwd: process.cwd(),
        processId: null,
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'sample.txt\n',
        exitCode: 0,
        durationMs: 3,
    });
    if (fails) {
        childTurn.status = 'failed';
        childTurn.error = { message: 'Synthetic child failure' };
        finishChildTurn(io, child, childTurn);
        await io.streamMessage(turn, 'The helper failed.', 0);
        return;
    }
    if (needsApproval) {
        const approval = io.serverRequest('item/commandExecution/requestApproval', {
            threadId: child.id,
            turnId: childTurn.id,
            itemId: crypto.randomUUID(),
            command: 'git status',
            cwd: process.cwd(),
            reason: 'Inspect the synthetic project',
        });
        // eslint-disable-next-line no-void -- the child's request outlives the parent turn
        void approval.then(async (response) => {
            if (childTurn.finished) return;
            const decision =
                typeof response === 'object' && response !== null && 'decision' in response
                    ? response.decision
                    : undefined;
            if (decision !== 'accept' && decision !== 'acceptForSession') {
                childTurn.interrupted = true;
                finishChildTurn(io, child, childTurn);
                return;
            }
            await io.streamMessage(childTurn, 'Approved the synthetic check. '.repeat(20), 30);
            finishChildTurn(io, child, childTurn);
        });
        await io.streamMessage(turn, 'A helper needs approval.', 0);
        return;
    }
    if (isHeld) {
        // eslint-disable-next-line no-void -- the child keeps working after the parent turn ends
        void io
            .streamMessage(childTurn, 'still working '.repeat(400), 50)
            .then(() => finishChildTurn(io, child, childTurn));
        await io.streamMessage(turn, 'A helper is working on it.', 0);
        return;
    }
    if (isBrowsing) await runBrowserStep(io, childTurn);
    await io.streamMessage(childTurn, 'Found one sample file.', 0);
    finishChildTurn(io, child, childTurn);
    const wait = {
        type: 'collabAgentToolCall',
        id: crypto.randomUUID(),
        tool: 'wait',
        status: 'inProgress',
        senderThreadId: parent.id,
        receiverThreadIds: [child.id],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
    };
    io.startItem(turn, { ...wait });
    io.completeItem(turn, {
        ...wait,
        status: 'completed',
        agentsStates: { [child.id]: { status: 'completed', message: 'Found one sample file.' } },
    });
    await io.streamMessage(turn, 'The helper finished.', 0);
}

/**
 * Mirrors `MAX_EXEC_OUTPUT_DELTAS_PER_CALL`: Codex streams no more output deltas for one command after this many.
 */
const MAX_OUTPUT_DELTAS = 10_000;

export async function runBackgroundCommand(
    io: FakeCodexIo,
    turn: FakeTurn,
    { isFlood, tickMs }: { isFlood: boolean; tickMs: number },
) {
    const processId = String(tasks.nextProcessId++);
    const command = {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "bun run dev"',
        cwd: process.cwd(),
        processId,
        source: 'unifiedExecStartup',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
    io.startItem(turn, { ...command });
    const terminal: FakeTerminal = {
        itemId: command.id,
        processId,
        command: command.command,
        output: '',
        turn,
    };
    tasks.terminals.set(processId, terminal);
    const emit = (delta: string) => {
        terminal.output += delta;
        io.notifyTurn(turn, 'item/commandExecution/outputDelta', {
            turnId: turn.id,
            itemId: command.id,
            delta,
        });
    };
    emit('server starting\n');
    if (isFlood) {
        for (let index = 1; index < MAX_OUTPUT_DELTAS; index += 1) emit('.');
    } else {
        let tick = 0;
        terminal.timer = setInterval(() => {
            tick += 1;
            emit(`tick ${tick}\n`);
        }, tickMs);
    }
    await io.streamMessage(turn, 'The dev server is running in the background.', 0);
}

/**
 * Codex cleans up every background terminal without a notification, as when its own housekeeping reaps them.
 */
export function dropTerminalsSilently() {
    for (const terminal of tasks.terminals.values()) clearInterval(terminal.timer);
    tasks.terminals.clear();
}

/**
 * A background terminal Codex runs but never announced on this connection, so only its list reports it.
 */
export function startUnannouncedTerminal(turn: FakeTurn) {
    const processId = String(tasks.nextProcessId++);
    const itemId = crypto.randomUUID();
    tasks.terminals.set(processId, {
        itemId,
        processId,
        command: '/bin/zsh -lc "tail -f server.log"',
        output: '',
        turn,
    });
}

function stopTerminal(io: FakeCodexIo, processId: string) {
    const terminal = tasks.terminals.get(processId);
    if (!terminal) return;
    clearInterval(terminal.timer);
    tasks.terminals.delete(processId);
    io.completeItem(terminal.turn, {
        type: 'commandExecution',
        id: terminal.itemId,
        command: terminal.command,
        cwd: process.cwd(),
        processId,
        source: 'unifiedExecStartup',
        status: 'failed',
        commandActions: [],
        aggregatedOutput: terminal.output,
        exitCode: 143,
        durationMs: 40,
    });
}

/**
 * How long after answering `thread/compact/start` the compaction turn starts, as Codex reports it in later
 * notifications.
 */
const COMPACTION_START_DELAY_MS = 50;

/**
 * Answers the background-work requests: compaction, `thread/read`, the background-terminal methods, and
 * `turn/interrupt` of a subagent thread. Returns false for a request the app-server handles itself.
 */
export function didHandleTaskRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters: Record<string, unknown>,
): boolean {
    switch (method) {
        case 'thread/compact/start': {
            // Codex answers the request before it reports the compaction turn, so the Chat briefly reads idle.
            io.send({ id, result: {} });
            setTimeout(() => {
                const turn = io.beginTurn();
                turn.isCompaction = true;
                const compaction = { type: 'contextCompaction', id: crypto.randomUUID() };
                io.startItem(turn, compaction);
                // Compaction takes a moment, so the Chat can show it in progress.
                setTimeout(
                    () => {
                        io.completeItem(turn, compaction);
                        io.finishTurn(turn);
                    },
                    JSON.stringify(io.currentThread().turns).includes('contextpressure')
                        ? 8000
                        : 150,
                );
            }, COMPACTION_START_DELAY_MS);
            return true;
        }
        case 'thread/read': {
            const threadId = String(parameters.threadId);
            const thread = tasks.children.get(threadId) ?? io.loadThread(threadId);
            if (!thread) {
                io.send({ id, error: { code: -32600, message: `thread not found: ${threadId}` } });
                return true;
            }
            io.send({
                id,
                result: {
                    thread: {
                        id: thread.id,
                        parentThreadId: thread.parentThreadId ?? null,
                        status: { type: 'idle' },
                        cwd: process.cwd(),
                        turns:
                            parameters.includeTurns === true
                                ? thread.turns.map((turn) => io.wireTurn(turn))
                                : [],
                    },
                },
            });
            return true;
        }
        case 'thread/backgroundTerminals/list': {
            io.send({
                id,
                result: {
                    data: tasks.terminals
                        .values()
                        .map((terminal) => ({
                            itemId: terminal.itemId,
                            processId: terminal.processId,
                            command: terminal.command,
                            cwd: process.cwd(),
                            osPid: null,
                            cpuPercent: null,
                            rssKb: null,
                        }))
                        .toArray(),
                    nextCursor: null,
                },
            });
            return true;
        }
        case 'thread/backgroundTerminals/terminate': {
            const processId = String(parameters.processId);
            const isTerminated = tasks.terminals.has(processId);
            if (isTerminated) {
                stopTerminal(io, processId);
                io.save();
            }
            io.send({ id, result: { terminated: isTerminated } });
            return true;
        }
        case 'turn/interrupt': {
            const childId = String(parameters.threadId);
            const child = tasks.children.get(childId);
            if (!child) return false;
            const childTurn = tasks.childTurns.get(childId);
            if (!childTurn || childTurn.id !== parameters.turnId) {
                io.send({ id, error: { code: -32600, message: 'no active turn to interrupt' } });
                return true;
            }
            childTurn.interrupted = true;
            childTurn.onFinished = () => io.send({ id, result: {} });
            setTimeout(() => finishChildTurn(io, child, childTurn), 10);
            return true;
        }
        default: {
            return false;
        }
    }
}
