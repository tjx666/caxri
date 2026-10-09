/**
 * Deterministic stand-in for `codex app-server --listen stdio://`, used by Agent Chat unit tests and fake-mode E2E so
 * no test ever launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a command needing approval; accept runs it, decline records it as declined.
 * - `ask`: a question; the reply quotes the chosen answer.
 * - `slow`: a long streamed reply that `turn/interrupt` can stop.
 * - `fail`: a failed turn with a provider error.
 * - `crash`: the process exits mid-turn.
 * - Anything else: reasoning, a plan, and a streamed reply quoting the message.
 *
 * Threads persist to `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.162.0\n');
    exitProcess(0);
}

const stateDirectory =
    process.env.FAKE_CODEX_STATE_DIR || path.join(os.tmpdir(), 'caxri-fake-codex');
fs.mkdirSync(stateDirectory, { recursive: true });

const pendingServerRequests = new Map();

/**
 * This file stands in for a CLI process, so exiting is part of its contract.
 */
function exitProcess(code) {
    // eslint-disable-next-line unicorn/no-process-exit -- see above
    process.exit(code);
}
/**
 * Mutable process state, kept on one object so handlers update it without reassigning module bindings.
 */
const state = { nextServerRequestId: 1000, thread: undefined, activeTurn: undefined };

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notify(method, parameters) {
    send({ method, params: { threadId: state.thread && state.thread.id, ...parameters } });
}
function threadPath(id) {
    return path.join(stateDirectory, `${id.replaceAll(/[^\w-]/g, '_')}.json`);
}
function save() {
    if (state.thread.turns.length > 0)
        fs.writeFileSync(threadPath(state.thread.id), JSON.stringify(state.thread));
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function serverRequest(method, parameters) {
    const id = state.nextServerRequestId++;
    send({ id, method, params: { threadId: state.thread.id, ...parameters } });
    return new Promise((resolve) => pendingServerRequests.set(id, resolve));
}

function startItem(turn, item) {
    turn.items.push(item);
    notify('item/started', { turnId: turn.id, item });
}
function completeItem(turn, item) {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) turn.items.push(item);
    else turn.items[index] = item;
    notify('item/completed', { turnId: turn.id, item });
}

async function streamMessage(turn, text, chunkDelayMs) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    startItem(turn, { ...item });
    for (const word of text.split(/(?<= )/u)) {
        if (turn.interrupted) return;
        item.text += word;
        notify('item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: word });
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        if (chunkDelayMs) await delay(chunkDelayMs);
    }
    completeItem(turn, item);
}

async function runTurn(turn, text) {
    const user = {
        type: 'userMessage',
        id: crypto.randomUUID(),
        clientId: null,
        content: [{ type: 'text', text, text_elements: [] }],
    };
    startItem(turn, user);
    completeItem(turn, user);
    if (text.includes('crash')) exitProcess(1);
    if (text.includes('approve')) {
        const command = {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: 'echo approved',
            cwd: process.cwd(),
            status: 'inProgress',
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
        };
        startItem(turn, { ...command });
        const response = await serverRequest('item/commandExecution/requestApproval', {
            turnId: turn.id,
            itemId: command.id,
            startedAtMs: Date.now(),
            command: command.command,
            cwd: command.cwd,
            reason: 'Fake approval',
        });
        if (
            response &&
            (response.decision === 'accept' || response.decision === 'acceptForSession')
        ) {
            notify('item/commandExecution/outputDelta', {
                turnId: turn.id,
                itemId: command.id,
                delta: 'approved\n',
            });
            completeItem(turn, {
                ...command,
                status: 'completed',
                aggregatedOutput: 'approved\n',
                exitCode: 0,
                durationMs: 5,
            });
            await streamMessage(turn, 'The command ran.', 0);
        } else {
            completeItem(turn, { ...command, status: 'declined' });
            await streamMessage(turn, 'The command was declined.', 0);
        }
    } else if (text.includes('ask')) {
        const item = { type: 'dynamicToolCall', id: crypto.randomUUID() };
        const response = await serverRequest('item/tool/requestUserInput', {
            turnId: turn.id,
            itemId: item.id,
            questions: [
                {
                    id: 'color',
                    header: 'Color',
                    question: 'Which color?',
                    isOther: true,
                    isSecret: false,
                    options: [
                        { label: 'Red', description: 'Warm' },
                        { label: 'Blue', description: 'Cool' },
                    ],
                },
            ],
        });
        const answer = response && response.answers && response.answers.color;
        await streamMessage(turn, `You chose ${(answer && answer.answers[0]) || 'nothing'}.`, 0);
    } else if (text.includes('slow')) {
        await streamMessage(turn, 'word '.repeat(200), 50);
    } else if (text.includes('fail')) {
        turn.status = 'failed';
        turn.error = { message: 'Fake provider failure' };
        notify('error', { turnId: turn.id, willRetry: false, error: turn.error });
    } else {
        const reasoning = { type: 'reasoning', id: crypto.randomUUID(), summary: [], content: [] };
        startItem(turn, { ...reasoning });
        notify('item/reasoning/summaryTextDelta', {
            turnId: turn.id,
            itemId: reasoning.id,
            delta: 'Thinking about it.',
            summaryIndex: 0,
        });
        completeItem(turn, { ...reasoning, summary: ['Thinking about it.'] });
        notify('turn/plan/updated', {
            turnId: turn.id,
            explanation: null,
            plan: [
                { step: 'Read the message', status: 'completed' },
                { step: 'Reply', status: 'inProgress' },
            ],
        });
        await streamMessage(turn, `Hello from fake Codex. You said: ${text}`, 0);
        notify('thread/tokenUsage/updated', {
            turnId: turn.id,
            tokenUsage: {
                total: { totalTokens: 1200 },
                last: { totalTokens: 1200 },
                modelContextWindow: 200000,
            },
        });
    }
    finishTurn(turn);
}

/**
 * The turn fields Codex sends; the fake's own bookkeeping flags stay private.
 */
function wireTurn(turn) {
    return {
        id: turn.id,
        items: turn.items,
        status: turn.status,
        error: turn.error,
        durationMs: turn.durationMs,
    };
}

function finishTurn(turn) {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.interrupted) turn.status = 'interrupted';
    else if (turn.status === 'inProgress') turn.status = 'completed';
    turn.durationMs = Date.now() - turn.startedAt;
    state.activeTurn = undefined;
    save();
    notify('turn/completed', { turn: { ...wireTurn(turn), items: [] } });
    if (turn.onFinished) turn.onFinished();
}

function threadResponse() {
    return {
        thread: {
            id: state.thread.id,
            status: { type: 'idle' },
            cwd: process.cwd(),
            turns: state.thread.turns.map(wireTurn),
        },
        model: 'fake-codex-model',
    };
}

function handle(message) {
    if (message.id !== undefined && message.method === undefined) {
        const resolve = pendingServerRequests.get(message.id);
        pendingServerRequests.delete(message.id);
        if (resolve) resolve(message.result);
        return;
    }
    const { id, method, params: parameters = {} } = message;
    switch (method) {
        case 'initialize': {
            send({ id, result: { userAgent: 'caxri/0.162.0 (fake)', platformOs: 'macos' } });
            return;
        }
        case 'initialized': {
            return;
        }
        case 'thread/start': {
            state.thread = { id: crypto.randomUUID(), turns: [] };
            send({ id, result: threadResponse() });
            return;
        }
        case 'thread/resume': {
            const file = threadPath(String(parameters.threadId));
            if (!fs.existsSync(file)) {
                send({
                    id,
                    error: {
                        code: -32600,
                        message: `no rollout found for thread id ${parameters.threadId}`,
                    },
                });
                return;
            }
            state.thread = JSON.parse(fs.readFileSync(file, 'utf8'));
            send({ id, result: threadResponse() });
            return;
        }
        case 'turn/start': {
            const text = (parameters.input || []).map((input) => input.text || '').join('\n');
            const turn = {
                id: crypto.randomUUID(),
                items: [],
                status: 'inProgress',
                error: null,
                startedAt: Date.now(),
            };
            state.thread.turns.push(turn);
            state.activeTurn = turn;
            send({ id, result: { turn: { id: turn.id, items: [], status: 'inProgress' } } });
            notify('turn/started', { turn: { id: turn.id, items: [], status: 'inProgress' } });
            runTurn(turn, text);
            return;
        }
        case 'turn/steer': {
            if (!state.activeTurn || state.activeTurn.id !== parameters.expectedTurnId) {
                send({ id, error: { code: -32600, message: 'no active turn to steer' } });
                return;
            }
            send({ id, result: { turnId: state.activeTurn.id } });
            return;
        }
        case 'turn/interrupt': {
            if (!state.activeTurn || state.activeTurn.id !== parameters.turnId) {
                send({ id, error: { code: -32600, message: 'no active turn to interrupt' } });
                return;
            }
            const turn = state.activeTurn;
            turn.interrupted = true;
            for (const [requestId, resolve] of pendingServerRequests) {
                pendingServerRequests.delete(requestId);
                resolve();
            }
            turn.onFinished = () => send({ id, result: {} });
            setTimeout(() => finishTurn(turn), 10);
            return;
        }
        default: {
            if (id !== undefined)
                send({ id, error: { code: -32600, message: `unknown variant \`${method}\`` } });
        }
    }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on('end', () => exitProcess(0));
