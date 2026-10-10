/**
 * Deterministic stand-in for `codex app-server --listen stdio://`, used by Agent Chat unit tests and fake-mode E2E so
 * no test ever launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a command needing approval; accept runs it, decline records it as declined.
 * - `patch`: a three-file change (update, add, delete) needing approval; nothing is written to disk.
 * - `bigdiff`: a completed file change whose diff is longer than Server Core keeps.
 * - `ask`: a question; the reply quotes the chosen answer.
 * - `slow`: a titled thought, a running command, and a long streamed reply that `turn/interrupt` can stop.
 * - `fail`: a failed turn with a provider error.
 * - `crash`: the process exits mid-turn.
 * - `table`: a reply exercising the transcript's Markdown: headings, nested and task lists, cited files, a quote, a
 *   table, and a fenced code block, streamed in small chunks.
 * - Anything else: reasoning, a plan, and a streamed reply quoting the message.
 *
 * A message with images is answered with how many it received, and `thread/compact/start` runs a compaction turn.
 *
 * Threads persist to `FAKE_CODEX_STATE_DIR` (or the OS temp directory) so `thread/resume` returns real history. Each
 * thread open also appends its method, sandbox, and approval policy to `thread-opens.jsonl` there, so tests can assert
 * the configuration Caxri asked for.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

/**
 * Loose JSON-RPC shapes: the fake only reads the fields it answers, and the Server's own schemas validate what it
 * emits.
 */
interface RpcMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}
interface FakeItem {
    id: string;
    type: string;
    [key: string]: unknown;
}
interface FakeTurn {
    id: string;
    items: FakeItem[];
    status: string;
    error: { message: string } | null;
    startedAt: number;
    durationMs?: number;
    interrupted?: boolean;
    finished?: boolean;
    onFinished?: () => void;
}
interface FakeThread {
    id: string;
    turns: FakeTurn[];
}
interface FakeInput {
    type: string;
    text?: string;
    url?: string;
}
interface ApprovalResponse {
    decision?: string;
}
interface QuestionResponse {
    answers?: Record<string, { answers: string[] } | undefined>;
}

if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.162.0\n');
    exitProcess(0);
}

const stateDirectory =
    process.env.FAKE_CODEX_STATE_DIR ?? path.join(os.tmpdir(), 'caxri-fake-codex');
fs.mkdirSync(stateDirectory, { recursive: true });

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
const state: { nextServerRequestId: number; thread?: FakeThread; activeTurn?: FakeTurn } = {
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
function threadPath(id: string) {
    return path.join(stateDirectory, `${id.replaceAll(/[^\w-]/gu, '_')}.json`);
}
function save() {
    const thread = currentThread();
    if (thread.turns.length > 0) fs.writeFileSync(threadPath(thread.id), JSON.stringify(thread));
}
function recordThreadOpen(method: string, parameters: Record<string, unknown>) {
    fs.appendFileSync(
        path.join(stateDirectory, 'thread-opens.jsonl'),
        `${JSON.stringify({ method, sandbox: parameters.sandbox, approvalPolicy: parameters.approvalPolicy })}\n`,
    );
}
function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function serverRequest(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const id = state.nextServerRequestId++;
    send({ id, method, params: { threadId: currentThread().id, ...parameters } });
    return new Promise((resolve) => pendingServerRequests.set(id, resolve));
}

function startItem(turn: FakeTurn, item: FakeItem) {
    turn.items.push(item);
    notify('item/started', { turnId: turn.id, item, startedAtMs: Date.now() });
}
function completeItem(turn: FakeTurn, item: FakeItem) {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) turn.items.push(item);
    else turn.items[index] = item;
    notify('item/completed', { turnId: turn.id, item, completedAtMs: Date.now() });
}

async function streamMessage(turn: FakeTurn, text: string, chunkDelayMs: number) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    startItem(turn, { ...item });
    for (const word of text.split(/(?<= )/u)) {
        if (turn.interrupted) return;
        item.text += word;
        notify('item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: word });
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
    }
    completeItem(turn, item);
}

async function runTurn(turn: FakeTurn, input: FakeInput[], clientId: string | null) {
    const text = input.map((entry) => entry.text ?? '').join('\n');
    const imageCount = input.filter((entry) => entry.type === 'image').length;
    const user = { type: 'userMessage', id: crypto.randomUUID(), clientId, content: input };
    startItem(turn, user);
    completeItem(turn, user);
    if (text.includes('crash')) exitProcess(1);
    if (imageCount > 0) {
        await streamMessage(turn, `Received ${imageCount} image${imageCount === 1 ? '' : 's'}.`, 0);
    } else if (text.includes('approve')) {
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
        const response = (await serverRequest('item/commandExecution/requestApproval', {
            turnId: turn.id,
            itemId: command.id,
            startedAtMs: Date.now(),
            command: command.command,
            cwd: command.cwd,
            reason: 'Fake approval',
        })) as ApprovalResponse | undefined;
        if (response?.decision === 'accept' || response?.decision === 'acceptForSession') {
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
    } else if (text.includes('patch')) {
        const change = {
            type: 'fileChange',
            id: crypto.randomUUID(),
            status: 'inProgress',
            changes: [
                {
                    path: path.join(process.cwd(), 'src', 'greeting.ts'),
                    kind: { type: 'update', move_path: null },
                    diff: [
                        '@@ -1,3 +1,4 @@',
                        ' export function greet(name: string) {',
                        "-    return 'Hello ' + name;",
                        '+    const greeting = `Hello, ${name}!`;',
                        '+    return greeting;',
                        ' }',
                        '',
                    ].join('\n'),
                },
                {
                    path: path.join(process.cwd(), 'docs', 'greeting.md'),
                    kind: { type: 'add' },
                    diff: '# Greeting\n\nCall `greet(name)`.\n',
                },
                {
                    path: path.join(process.cwd(), 'legacy.txt'),
                    kind: { type: 'delete' },
                    diff: 'unused\n',
                },
            ],
        };
        startItem(turn, { ...change });
        const response = (await serverRequest('item/fileChange/requestApproval', {
            turnId: turn.id,
            itemId: change.id,
            startedAtMs: Date.now(),
            reason: 'Fake file change',
            grantRoot: null,
        })) as ApprovalResponse | undefined;
        const isAccepted =
            response?.decision === 'accept' || response?.decision === 'acceptForSession';
        completeItem(turn, { ...change, status: isAccepted ? 'completed' : 'declined' });
        await streamMessage(
            turn,
            isAccepted ? 'The files were changed.' : 'The change was declined.',
            0,
        );
    } else if (text.includes('bigdiff')) {
        const lineCount = 6000;
        const lines = Array.from(
            { length: lineCount },
            (_, index) => `+generated line ${String(index + 1).padStart(5, '0')}`,
        );
        completeItem(turn, {
            type: 'fileChange',
            id: crypto.randomUUID(),
            status: 'completed',
            changes: [
                {
                    path: path.join(process.cwd(), 'generated.txt'),
                    kind: { type: 'update', move_path: null },
                    diff: [`@@ -0,0 +1,${lineCount} @@`, ...lines, ''].join('\n'),
                },
            ],
        });
        await streamMessage(turn, 'Generated a large file.', 0);
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
        ran('cat src/app.ts', 'export const answer: number = 42;\n');
        ran('git status --short', ' M src/app.ts\n');
        completeItem(turn, {
            type: 'mcpToolCall',
            id: crypto.randomUUID(),
            server: 'docs',
            tool: 'search',
            status: 'completed',
            arguments: { query: 'greet' },
            result: { content: [{ type: 'text', text: '{"hits": 1}' }] },
            durationMs: 5,
        });
        await streamMessage(turn, 'Explored the project.', 0);
    } else if (text.includes('ask')) {
        const item = { type: 'dynamicToolCall', id: crypto.randomUUID() };
        const response = (await serverRequest('item/tool/requestUserInput', {
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
        })) as QuestionResponse | undefined;
        const answer = response?.answers?.color?.answers[0];
        await streamMessage(turn, `You chose ${answer ?? 'nothing'}.`, 0);
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
    } else if (text.includes('table')) {
        await streamMessage(
            turn,
            [
                '## Summary',
                '',
                'Updated [app.ts](src/app.ts:2) and `src/app.ts#L1-L2`; see **the plan** below.',
                '',
                '### Plan',
                '',
                '1. Read the *current* state',
                '   - check `package.json`',
                '   - compare with ~~old~~ new',
                '2. Apply the fix',
                '',
                '- [x] Write tests',
                '- [ ] Ship it',
                '',
                '> Note: nothing outside the Project was touched.',
                '',
                '| Option | Cost |',
                '| :--- | ---: |',
                '| Fast | 2 |',
                '| Safe | 5 |',
                '',
                '```ts',
                'const choice = "Safe";',
                'export function pick(cost: number): string {',
                '    return cost > 3 ? choice : "Fast";',
                '}',
                '```',
            ].join('\n'),
            5,
        );
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
function wireTurn(turn: FakeTurn) {
    return {
        id: turn.id,
        items: turn.items,
        status: turn.status,
        error: turn.error,
        durationMs: turn.durationMs,
    };
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

function threadResponse() {
    const thread = currentThread();
    return {
        thread: {
            id: thread.id,
            status: { type: 'idle' },
            cwd: process.cwd(),
            turns: thread.turns.map((turn) => wireTurn(turn)),
        },
        model: 'fake-codex-model',
    };
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
            send({ id, result: threadResponse() });
            return;
        }
        case 'thread/resume': {
            recordThreadOpen(method, parameters);
            const threadId = String(parameters.threadId);
            const file = threadPath(threadId);
            if (!fs.existsSync(file)) {
                send({
                    id,
                    error: { code: -32600, message: `no rollout found for thread id ${threadId}` },
                });
                return;
            }
            state.thread = JSON.parse(fs.readFileSync(file, 'utf8')) as FakeThread;
            send({ id, result: threadResponse() });
            return;
        }
        case 'thread/compact/start': {
            const turn = beginFakeTurn();
            send({ id, result: {} });
            const compaction = { type: 'contextCompaction', id: crypto.randomUUID() };
            startItem(turn, compaction);
            completeItem(turn, compaction);
            finishTurn(turn);
            return;
        }
        case 'turn/start': {
            const input = (parameters.input ?? []) as FakeInput[];
            const clientId =
                typeof parameters.clientUserMessageId === 'string'
                    ? parameters.clientUserMessageId
                    : null;
            const turn: FakeTurn = {
                id: crypto.randomUUID(),
                items: [],
                status: 'inProgress',
                error: null,
                startedAt: Date.now(),
            };
            currentThread().turns.push(turn);
            state.activeTurn = turn;
            send({ id, result: { turn: { id: turn.id, items: [], status: 'inProgress' } } });
            notify('turn/started', { turn: { id: turn.id, items: [], status: 'inProgress' } });
            // eslint-disable-next-line no-void -- the turn streams its own notifications after this response
            void runTurn(turn, input, clientId);
            return;
        }
        case 'turn/steer': {
            if (state.activeTurn?.id !== parameters.expectedTurnId) {
                send({ id, error: { code: -32600, message: 'no active turn to steer' } });
                return;
            }
            send({ id, result: { turnId: state.activeTurn?.id } });
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
