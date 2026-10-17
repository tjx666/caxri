/**
 * Deterministic stand-in for `codex app-server --listen stdio://`, used by Agent Chat unit tests and fake-mode E2E so
 * no test ever launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a command needing approval; accept runs it, decline records it as declined.
 * - `artifacts`: edits and creates files on disk, opens a pull request, rewrites another through `gh api`, files a Linear
 *   issue, and publishes an acceptance report.
 * - `manyfiles`: creates five notes on disk, so a turn card folds the files past its first rows.
 * - `patch`: a three-file change (update, add, delete) needing approval; nothing is written to disk.
 * - `bigdiff`: a completed file change whose diff is longer than Server Core keeps.
 * - `browsestep`: a Computer Use browser step that binds a tab, then one that drives it and stays running briefly before
 *   its result reports the browser surface.
 * - `ask`: a question; the reply quotes the chosen answer.
 * - `slow`: a titled thought, a running command, and a long streamed reply that `turn/interrupt` can stop.
 * - `longstream`: a titled thought, a quiet pause of a few seconds, then a reply of forty numbered paragraphs streamed
 *   over about 30 seconds, which `turn/interrupt` can stop.
 * - `weblink`: a reply that only links the message's first `http(s)` URL; matched before any keyword the URL may hold.
 * - `fail`: a failed turn with a provider error.
 * - `crash`: the process exits mid-turn, after saving the turn's user message as an interrupted turn.
 * - `table`: a reply exercising the transcript's Markdown: headings, nested and task lists, cited files, a quote, a
 *   table, and a fenced code block, streamed in small chunks.
 * - `codeblocks`: a reply with fenced code in `ts`, `bash`, `json`, and `diff`, a fence without a language, and an
 *   indented code block, so a Client's syntax highlighting can be compared across languages.
 * - `testrun`: a finished multi-step turn: a thought, a test command that exits with code 1, a passing command, and a
 *   short reply, so a Client folds the work behind its `Worked for` row and shows the failed command's exit code.
 * - `subagent`: a `spawnAgent` collab call whose child thread runs its own turn (notifications with the child's
 *   `threadId`, some before the spawn completes, as real Codex sends them), then a `wait` call reporting its result.
 *   With `hold`, the child keeps streaming until `turn/interrupt` stops it and the parent turn ends right away. With
 *   `browsestep`, the child runs the `browsestep` steps first.
 * - `background`: a unified-exec command (with a `processId`) that outlives its turn, streaming output until
 *   `thread/backgroundTerminals/terminate` stops it. With `flood`, it emits Codex's 10,000 output deltas at once; with
 *   `quiet`, it prints one line a second instead of one every 30 ms, so a phone screen showing it can settle.
 * - `vanish`: every background terminal disappears from `thread/backgroundTerminals/list` without a notification.
 * - `unannounced`: a background terminal only `thread/backgroundTerminals/list` reports.
 * - Anything else: reasoning, a plan, and a streamed reply quoting the message.
 *
 * A message with images is answered with how many it received; one containing `unpaired` is echoed without its client
 * id, as a resumed thread reads after Server Core restarted and no longer holds the thumbnails, and
 * `thread/compact/start` runs a compaction turn that stays in progress briefly and cannot be steered. `turn/steer`
 * echoes the steered message into the running turn; a steered message containing `late` ends the turn first, so the
 * steer loses that race, and one containing `refuse` is rejected outright. A started or steered message containing
 * `stall` is recorded at once but answered only after {@link STALL_MS}, as a loaded Codex answers past Caxri's request
 * timeout; one containing `lost` is never answered nor recorded. `thread/turns/list` returns the newest turns with
 * their items, and `thread/items/list` the newest items with when each started. `model/list` offers two models, and a
 * `turn/start` that names a model, effort, or service tier saves it on the thread, as Codex does, so a resumed thread
 * reports the last choice.
 *
 * Threads persist to `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history. Each
 * thread open also appends its method, sandbox, and approval policy to `thread-opens.jsonl` there, so tests can assert
 * the configuration Caxri asked for (`fake-codex-threads.ts`). A `<threadId>.writer-held` file there makes resuming
 * that thread fail as Codex does when another client still holds the thread's writer, and an `unsubscribe-fails` file
 * makes `thread/unsubscribe` answer with an error. `config/read` reports `readFakeConfig`'s workspace-write table.
 * `thread/goal/*` keeps a thread goal that starts its own turns while active (`fake-codex-goals.ts`).
 */
import crypto from 'node:crypto';
import process from 'node:process';
import readline from 'node:readline';

import {
    runApprovalCommand,
    runApprovalPatch,
    runQuestion,
    runQuestions,
} from './fake-codex-approvals.ts';
import { runTurnArtifacts, runTurnManyFiles } from './fake-codex-artifacts.ts';
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
import {
    completeMcpCalls,
    didHandleMcpStatusRequest,
    runBrowserStep,
} from './fake-codex-mcp-calls.ts';
import { FAKE_MODELS } from './fake-codex-models.ts';
import {
    runBigDiff,
    runCodeBlocks,
    runLongStream,
    runMarkdownTable,
    runTestCommands,
    runWebLink,
} from './fake-codex-replies.ts';
import { forkThread, revertThread, unsubscribeThread } from './fake-codex-rewind.ts';
import {
    didHandleTaskRequest,
    dropTerminalsSilently,
    runBackgroundCommand,
    runSubagent,
    startUnannouncedTerminal,
} from './fake-codex-tasks.ts';
import {
    fakeCodexStateDirectory,
    readFakeConfig,
    readSavedThread,
    recordThreadOpen,
    recordTurnStart,
    resumeSavedThread,
    saveThread,
    threadPath,
} from './fake-codex-threads.ts';

if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.162.0\n');
    exitProcess(0);
}

/**
 * How long a `stall` message's `turn/start` or `turn/steer` answer is held back.
 */
const STALL_MS = 1_000;

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

async function streamMessage(turn: FakeTurn, text: string, chunkDelayMs: number) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    startItem(turn, { ...item });
    for (const word of text.split(/(?<= )/u)) {
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
    if (text.includes('crash')) {
        // Codex records a turn's user message as the turn starts, so a thread resumed after the crash still holds it,
        // in a turn that never completed.
        turn.status = 'interrupted';
        save();
        exitProcess(1);
    }
    if (imageCount > 0) {
        await streamMessage(turn, `Received ${imageCount} image${imageCount === 1 ? '' : 's'}.`, 0);
    } else if (text.includes('weblink')) {
        await runWebLink(io, turn, text);
    } else if (text.includes('longstream')) {
        await runLongStream(io, turn);
    } else if (text.includes('subagent')) {
        await runSubagent(io, turn, {
            isHeld: text.includes('hold'),
            isBrowsing: text.includes('browsestep'),
        });
    } else if (text.includes('vanish')) {
        dropTerminalsSilently();
        await streamMessage(turn, 'Done.', 0);
    } else if (text.includes('unannounced')) {
        startUnannouncedTerminal(turn);
        await streamMessage(turn, 'Done.', 0);
    } else if (text.includes('background')) {
        await runBackgroundCommand(io, turn, {
            isFlood: text.includes('flood'),
            tickMs: text.includes('quiet') ? 1_000 : 30,
        });
    } else if (text.includes('approve')) {
        await runApprovalCommand(io, turn);
    } else if (text.includes('artifacts')) {
        await runTurnArtifacts(io, turn);
    } else if (text.includes('manyfiles')) {
        await runTurnManyFiles(io, turn);
    } else if (text.includes('patch')) {
        await runApprovalPatch(io, turn);
    } else if (text.includes('bigdiff')) {
        await runBigDiff(io, turn);
    } else if (text.includes('browsestep')) {
        await runBrowserStep(io, turn);
    } else if (text.includes('explore')) {
        /**
         * Consecutive tool calls the Chat groups into one summary row, with output it can paint.
         */
        const ran = (command: string, output: string) =>
            completeItem(turn, {
                type: 'commandExecution',
                id: crypto.randomUUID(),
                command: `/bin/zsh -lc "${command}"`,
                cwd: process.cwd(),
                status: 'completed',
                aggregatedOutput: output,
                exitCode: 0,
                durationMs: 5,
            });
        // Commentary before the work, which the Chat shows without the Copy action only the final reply carries.
        await streamMessage(turn, 'Looking around the project.', 0);
        ran('cat src/app.ts', 'export const answer: number = 42;\n');
        if (text.includes('gradual')) await delay(200);
        ran('git status --short', ' M src/app.ts\n');
        // Enough reads that the expanded group scrolls, each shown as the file it read rather than its command line.
        for (let start = 1; start <= 81; start += 10) {
            ran(`sed -n '${start},${start + 9}p' src/app.ts`, '');
            // eslint-disable-next-line no-await-in-loop -- paced tool events expose first-paint grouping.
            if (text.includes('gradual')) await delay(200);
        }
        completeMcpCalls(io, turn);
        await streamMessage(turn, 'Explored the project.', 0);
    } else if (text.includes('several questions') || text.includes('askmany')) {
        // `askmany` is the one-word form a phone can type: `adb input text` drops spaces.
        await runQuestions(io, turn);
    } else if (text.includes('ask')) {
        await runQuestion(io, turn);
    } else if (text.includes('slow')) {
        // A titled thought and a command still running while the reply streams, so live work is on screen.
        completeItem(turn, {
            type: 'reasoning',
            id: crypto.randomUUID(),
            summary: ['**Planning the reply**\n\nTake it slow.'],
            content: [],
        });
        const command = {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: '/bin/zsh -lc "rg -n slow src"',
            cwd: process.cwd(),
            aggregatedOutput: '',
        };
        startItem(turn, { ...command, status: 'inProgress' });
        await streamMessage(turn, 'word '.repeat(200), 50);
        // An interrupted turn leaves the command dangling, which closing the turn settles.
        if (!turn.interrupted) completeItem(turn, { ...command, status: 'completed', exitCode: 0 });
    } else if (text.includes('codeblocks')) {
        await runCodeBlocks(io, turn);
    } else if (text.includes('testrun')) {
        await runTestCommands(io, turn);
    } else if (text.includes('table')) {
        await runMarkdownTable(io, turn);
    } else if (text.includes('fail')) {
        turn.status = 'failed';
        turn.error = { message: 'Fake provider failure' };
        notify('error', { turnId: turn.id, willRetry: false, error: turn.error });
    } else {
        const reasoning = { type: 'reasoning', id: crypto.randomUUID(), summary: [], content: [] };
        startItem(turn, { ...reasoning });
        /**
         * Real Codex announces every summary part, including the first, before streaming its text.
         */
        const summary = ['Thinking about it.', 'Checking the reply.'];
        for (const [summaryIndex, delta] of summary.entries()) {
            notify('item/reasoning/summaryPartAdded', {
                turnId: turn.id,
                itemId: reasoning.id,
                summaryIndex,
            });
            notify('item/reasoning/summaryTextDelta', {
                turnId: turn.id,
                itemId: reasoning.id,
                delta,
                summaryIndex,
            });
        }
        completeItem(turn, { ...reasoning, summary });
        notify('turn/plan/updated', {
            turnId: turn.id,
            explanation: null,
            plan: [
                { step: 'Read the message', status: 'completed' },
                { step: 'Reply', status: 'inProgress' },
            ],
        });
        await streamMessage(turn, `Hello from fake Codex. You said: ${said}`, 0);
        notify('thread/tokenUsage/updated', {
            turnId: turn.id,
            tokenUsage: {
                total: { totalTokens: 1200 },
                last: {
                    totalTokens: 1200,
                    inputTokens: 1150,
                    cachedInputTokens: 900,
                    outputTokens: 50,
                },
                modelContextWindow: 200000,
            },
        });
    }
    finishTurn(turn);
}

function finishTurn(turn: FakeTurn) {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.interrupted) turn.status = 'interrupted';
    else if (turn.status === 'inProgress') turn.status = 'completed';
    turn.durationMs = Date.now() - turn.startedAt;
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
    if (didHandleMcpStatusRequest(io, id, method, parameters)) return;
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
            state.thread = { id: crypto.randomUUID(), turns: [] };
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
            state.thread = resumed.thread;
            send({ id, result: threadResponse(currentThread()) });
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
        case 'model/list': {
            send({ id, result: { data: FAKE_MODELS, nextCursor: null } });
            return;
        }
        case 'turn/start': {
            const input = (parameters.input ?? []) as FakeInput[];
            const text = input.map((entry) => entry.text ?? '').join('\n');
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
            // eslint-disable-next-line no-void -- the turn streams its own notifications after this response
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
            startItem(turn, user);
            completeItem(turn, user);
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
