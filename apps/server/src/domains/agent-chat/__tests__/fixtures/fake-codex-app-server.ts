/**
 * Deterministic stand-in for `codex app-server --listen stdio://`, used by Agent Chat unit tests and fake-mode E2E so
 * no test ever launches the real CLI or calls a model. Behavior is selected by keywords in the user's message
 * (`fake-codex-keywords.ts`).
 *
 * A message with images is answered with how many it received; one containing `unpaired` is echoed without its client
 * id, as a resumed thread reads after Server Core restarted and no longer holds the thumbnails, and
 * `thread/compact/start` runs a compaction turn that stays in progress briefly and cannot be steered. `turn/steer`
 * echoes the steered message into the running turn; a steered message containing `late` ends the turn first, so the
 * steer loses that race, one containing `refuse` is rejected outright, and one containing `answer` gets its own command
 * and reply inside the running turn. A started or steered message containing `stall` is recorded at once but answered
 * only after {@link STALL_MS}, as a loaded Codex answers past Caxri's request timeout; one containing `lost` is never
 * answered nor recorded. `thread/turns/list` returns the newest turns with their items, and `thread/items/list` the
 * newest items with when each started. `model/list` offers two models, and a `turn/start` that names a model, effort,
 * or service tier saves it on the thread, as Codex does, so a resumed thread reports the last choice.
 *
 * With `FAKE_CODEX_SCRIPT`, a message equal to a scripted turn's prompt plays that turn (`fake-codex-script.ts`).
 *
 * Threads persist to `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history. Each
 * thread open also appends its method, sandbox, and approval policy to `thread-opens.jsonl` there, so tests can assert
 * the configuration Caxri asked for (`fake-codex-threads.ts`). A `<threadId>.writer-held` file there makes resuming
 * that thread fail as Codex does when another client still holds the thread's writer, a `resume-delay-ms` file delays
 * every `thread/resume` answer by that many milliseconds, and an `unsubscribe-fails` file makes `thread/unsubscribe`
 * answer with an error. `config/read` reports `readFakeConfig`'s workspace-write table. An ephemeral `thread/fork`
 * opens a side thread that answers one `turn/start` (`fake-codex-side.ts`). `thread/goal/*` keeps a thread goal that
 * starts its own turns while active (`fake-codex-goals.ts`). With `FAKE_CODEX_SESSIONS_DIR`, threads get UUIDv7 ids and
 * each user message is also appended to a rollout there, as the real CLI writes it.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import readline from 'node:readline';

import { didHandleAccountRequest } from './fake-codex-account.ts';
import { didHandleGoalRequest } from './fake-codex-goals.ts';
import {
    listThreadItems,
    listThreadTurns,
    threadResponse,
    wireTurn,
} from './fake-codex-history.ts';
import type {
    FakeCodexIo,
    FakeInput,
    FakeItem,
    FakeThread,
    FakeTurn,
    RpcMessage,
} from './fake-codex-io.ts';
import { runKeywordScenario } from './fake-codex-keywords.ts';
import { didHandleMcpStatusRequest } from './fake-codex-mcp-calls.ts';
import { FAKE_MODELS } from './fake-codex-models.ts';
import { forkThread, revertThread, unsubscribeThread } from './fake-codex-rewind.ts';
import { fakeCodexScript, findScriptedTurn, playScriptedTurn } from './fake-codex-script.ts';
import { didHandleSideRequest } from './fake-codex-side.ts';
import { didHandleSkillsListRequest } from './fake-codex-skills.ts';
import { answerSteeredMessage } from './fake-codex-steer.ts';
import { didHandleTaskRequest, wakeFakeWait } from './fake-codex-tasks.ts';
import {
    fakeCodexStateDirectory,
    newThreadId,
    readFakeConfig,
    readSavedThread,
    recordRolloutUserMessage,
    recordThreadOpen,
    recordTurnStart,
    resumeDelayMs,
    resumeSavedThread,
    saveThread,
    threadPath,
    writeFakeConfig,
} from './fake-codex-threads.ts';

if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.162.0\n');
    exitProcess(0);
}

/**
 * How long a `stall` message's `turn/start` or `turn/steer` answer is held back.
 */
const STALL_MS = 1_000;

/**
 * The scripted turns `FAKE_CODEX_SCRIPT` names; a malformed script ends the process here, at startup.
 */
const script = fakeCodexScript();

const pendingServerRequests = new Map<number, (result: unknown) => void>();

/**
 * This file stands in for a CLI process, so exiting is part of its contract.
 */
function exitProcess(code: number): never {
    // eslint-disable-next-line unicorn/no-process-exit -- see above
    process.exit(code);
}
/**
 * Mutable process state, kept on one object so handlers update it without reassigning module bindings.
 */
const state: {
    nextServerRequestId: number;
    thread?: FakeThread;
    activeTurn?: FakeTurn;
} = {
    nextServerRequestId: 1000,
};

function currentThread(): FakeThread {
    if (!state.thread) throw new Error('No thread has been started.');
    return state.thread;
}
function send(message: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notify(method: string, parameters: Record<string, unknown>) {
    send({ method, params: { threadId: state.thread?.id, ...parameters } });
}
/**
 * A notification of the thread `turn` belongs to: a child thread's carry the child's id, as app-server sends them on
 * the same connection.
 */
function notifyTurn(turn: FakeTurn, method: string, parameters: Record<string, unknown>) {
    send({ method, params: { threadId: turn.threadId ?? state.thread?.id, ...parameters } });
}
function save(thread = currentThread()) {
    saveThread(thread);
}
function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Answers a turn request, held back for a `stall` message.
 */
function answerTurnRequest(text: string, message: Record<string, unknown>) {
    if (text.includes('stall')) setTimeout(() => send(message), STALL_MS);
    else send(message);
}
function serverRequest(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const id = state.nextServerRequestId++;
    send({ id, method, params: { threadId: currentThread().id, ...parameters } });
    return new Promise((resolve) => pendingServerRequests.set(id, resolve));
}

function startItem(turn: FakeTurn, item: FakeItem) {
    turn.items.push(item);
    turn.itemTimes = { ...turn.itemTimes, [item.id]: Date.now() };
    notifyTurn(turn, 'item/started', { turnId: turn.id, item, startedAtMs: Date.now() });
}
function completeItem(turn: FakeTurn, item: FakeItem) {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) turn.items.push(item);
    else turn.items[index] = item;
    notifyTurn(turn, 'item/completed', { turnId: turn.id, item, completedAtMs: Date.now() });
}

/**
 * Streams `text` word by word, or as the given deltas when it is already split, `chunkDelayMs` apart.
 */
async function streamMessage(
    turn: FakeTurn,
    text: string | readonly string[],
    chunkDelayMs: number,
) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    startItem(turn, { ...item });
    const deltas = typeof text === 'string' ? text.split(/(?<= )/u) : text;
    for (const word of deltas) {
        if (turn.interrupted) return;
        item.text += word;
        notifyTurn(turn, 'item/agentMessage/delta', {
            turnId: turn.id,
            itemId: item.id,
            delta: word,
        });
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
    }
    completeItem(turn, item);
}

function loadThread(id: string): FakeThread | undefined {
    if (state.thread?.id === id) return state.thread;
    return readSavedThread(id);
}

const io: FakeCodexIo = {
    send,
    notifyTurn,
    startItem,
    completeItem,
    streamMessage,
    save,
    currentThread,
    loadThread,
    wireTurn,
    beginTurn: beginFakeTurn,
    hasActiveTurn: () => state.activeTurn !== undefined,
    finishTurn,
    serverRequest,
};

async function runTurn(turn: FakeTurn, input: FakeInput[], clientId: string | null) {
    const said = input.map((entry) => entry.text ?? '').join('\n');
    // A delegation pointer selects no scenario: its "task" says `ask`, a `dispatch-` ID says `patch`.
    const text = said.startsWith('Read the delegated task from ') ? '' : said;
    const imageCount = input.filter((entry) => entry.type === 'image').length;
    const user = { type: 'userMessage', id: crypto.randomUUID(), clientId, content: input };
    startItem(turn, user);
    completeItem(turn, user);
    recordRolloutUserMessage(currentThread().id, turn.id, user);
    const scripted = findScriptedTurn(script, said);
    if (scripted) {
        await playScriptedTurn(io, turn, scripted);
        finishTurn(turn);
        return;
    }
    if (text.includes('crash')) {
        // Codex records a turn's user message as the turn starts, so a thread resumed after the crash still holds it,
        // in a turn that never completed.
        turn.status = 'interrupted';
        save();
        exitProcess(1);
    }
    await runKeywordScenario(io, turn, { text, said, imageCount });
    finishTurn(turn);
}

function finishTurn(turn: FakeTurn) {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.interrupted) turn.status = 'interrupted';
    else if (turn.status === 'inProgress') turn.status = 'completed';
    turn.durationMs = turn.scriptedDurationMs ?? Date.now() - turn.startedAt;
    state.activeTurn = undefined;
    save();
    notify('turn/completed', { turn: { ...wireTurn(turn), items: [] } });
    turn.onFinished?.();
}

/**
 * Starts a turn Caxri did not ask for with `turn/start`, as Codex does for compaction.
 */
function beginFakeTurn(): FakeTurn {
    const turn: FakeTurn = {
        id: crypto.randomUUID(),
        items: [],
        status: 'inProgress',
        error: null,
        startedAt: Date.now(),
    };
    currentThread().turns.push(turn);
    state.activeTurn = turn;
    notify('turn/started', { turn: { id: turn.id, items: [], status: 'inProgress' } });
    return turn;
}

function handle(message: RpcMessage) {
    if (message.id !== undefined && message.method === undefined) {
        const resolve = pendingServerRequests.get(message.id);
        pendingServerRequests.delete(message.id);
        resolve?.(message.result);
        return;
    }
    const { id, method, params: parameters = {} } = message;
    if (didHandleTaskRequest(io, id, method, parameters)) return;
    if (didHandleGoalRequest(io, id, method, parameters)) return;
    if (didHandleSideRequest(io, id, method, parameters)) return;
    if (didHandleMcpStatusRequest(io, id, method, parameters)) return;
    if (didHandleSkillsListRequest(io, id, method, parameters)) return;
    if (didHandleAccountRequest(io, id, method)) return;
    switch (method) {
        case 'initialize': {
            send({ id, result: { userAgent: 'caxri/0.162.0 (fake)', platformOs: 'macos' } });
            return;
        }
        case 'initialized': {
            return;
        }
        case 'thread/start': {
            recordThreadOpen(method, parameters);
            state.thread = { id: newThreadId(), turns: [] };
            send({ id, result: threadResponse(currentThread()) });
            return;
        }
        case 'thread/resume': {
            recordThreadOpen(method, parameters);
            const resumed = resumeSavedThread(String(parameters.threadId));
            if ('error' in resumed) {
                send({ id, error: resumed.error });
                return;
            }
            const reply = () => {
                state.thread = resumed.thread;
                send({ id, result: threadResponse(currentThread()) });
            };
            const wait = resumeDelayMs();
            if (wait > 0) setTimeout(reply, wait);
            else reply();
            return;
        }
        case 'thread/revert': {
            const thread = currentThread();
            const reverted = revertThread(thread, parameters.beforeTurnId, {
                isTurnActive: state.activeTurn !== undefined,
                threadFile: threadPath(thread.id),
                stateDirectory: fakeCodexStateDirectory(),
            });
            send({ id, ...reverted });
            if ('result' in reverted) notify('thread/reverted', {});
            return;
        }
        case 'thread/fork': {
            send({
                id,
                ...forkThread(currentThread(), parameters.beforeTurnId, {
                    stateDirectory: fakeCodexStateDirectory(),
                    threadPath,
                }),
            });
            return;
        }
        case 'thread/unsubscribe': {
            send({ id, ...unsubscribeThread(fakeCodexStateDirectory()) });
            return;
        }
        case 'config/read': {
            send({ id, result: readFakeConfig() });
            return;
        }
        case 'config/batchWrite': {
            send({ id, result: writeFakeConfig(parameters) });
            return;
        }
        case 'model/list': {
            send({ id, result: { data: FAKE_MODELS, nextCursor: null } });
            return;
        }
        case 'turn/start': {
            const input = (parameters.input ?? []) as FakeInput[];
            const said = input.map((entry) => entry.text ?? '').join('\n');
            // A scripted prompt bypasses the keyword scenarios, so "Install" never trips `stall`.
            const text = findScriptedTurn(script, said) ? '' : said;
            if (text.includes('lost')) return;
            const clientId =
                typeof parameters.clientUserMessageId === 'string' && !text.includes('unpaired')
                    ? parameters.clientUserMessageId
                    : null;
            const turn: FakeTurn = {
                id: crypto.randomUUID(),
                items: [],
                status: 'inProgress',
                error: null,
                startedAt: Date.now(),
            };
            const thread = currentThread();
            if (typeof parameters.model === 'string') thread.model = parameters.model;
            if (typeof parameters.effort === 'string') thread.effort = parameters.effort;
            if (typeof parameters.serviceTier === 'string')
                thread.serviceTier = parameters.serviceTier;
            recordTurnStart(parameters);
            const collaboration = parameters.collaborationMode as { mode?: unknown } | undefined;
            if (typeof collaboration?.mode === 'string')
                thread.collaborationMode = collaboration.mode;
            thread.turns.push(turn);
            state.activeTurn = turn;
            answerTurnRequest(text, {
                id,
                result: { turn: { id: turn.id, items: [], status: 'inProgress' } },
            });
            notify('turn/started', { turn: { id: turn.id, items: [], status: 'inProgress' } });
            void runTurn(turn, input, clientId);
            return;
        }
        case 'turn/steer': {
            const input = (parameters.input ?? []) as FakeInput[];
            const text = input.map((entry) => entry.text ?? '').join('\n');
            if (text.includes('lost')) return;
            const active = state.activeTurn;
            if (active && text.includes('late')) {
                // The turn ends between Caxri reading it as running and the steer arriving.
                active.interrupted = true;
                finishTurn(active);
            }
            if (text.includes('refuse')) {
                send({ id, error: { code: -32600, message: 'steering is not available' } });
                return;
            }
            const turn = state.activeTurn;
            if (!turn || turn.id !== parameters.expectedTurnId) {
                send({ id, error: { code: -32600, message: 'no active turn to steer' } });
                return;
            }
            if (turn.isCompaction) {
                send({ id, error: { code: -32600, message: 'cannot steer a compact turn' } });
                return;
            }
            answerTurnRequest(text, { id, result: { turnId: turn.id } });
            // Codex records steered input as a user message of the running turn, echoing its client id.
            const user = {
                type: 'userMessage',
                id: crypto.randomUUID(),
                clientId:
                    typeof parameters.clientUserMessageId === 'string'
                        ? parameters.clientUserMessageId
                        : null,
                content: input,
            };
            const record = () => {
                startItem(turn, user);
                completeItem(turn, user);
                wakeFakeWait();
                if (text.includes('answer')) answerSteeredMessage(io, turn, text);
            };
            if (turn.deferredSteers) turn.deferredSteers.push(record);
            else record();
            return;
        }
        case 'thread/items/list': {
            send({ id, result: listThreadItems(currentThread(), parameters) });
            return;
        }
        case 'thread/turns/list': {
            send({ id, result: listThreadTurns(currentThread(), parameters) });
            return;
        }
        case 'turn/interrupt': {
            const turn = state.activeTurn;
            if (!turn || turn.id !== parameters.turnId) {
                send({ id, error: { code: -32600, message: 'no active turn to interrupt' } });
                return;
            }
            turn.interrupted = true;
            for (const [requestId, resolve] of pendingServerRequests) {
                pendingServerRequests.delete(requestId);
                resolve(undefined);
            }
            turn.onFinished = () => send({ id, result: {} });
            setTimeout(() => finishTurn(turn), 10);
            return;
        }
        default: {
            if (id !== undefined)
                send({
                    id,
                    error: { code: -32600, message: `unknown variant \`${String(method)}\`` },
                });
        }
    }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim()) handle(JSON.parse(line) as RpcMessage);
});
process.stdin.on('end', () => exitProcess(0));
