/**
 * Deterministic stand-in for `grok agent --no-leader stdio` (ACP over newline-delimited JSON-RPC), used by Agent Chat
 * unit tests and fake-mode E2E so no test ever launches the real CLI or calls a model. Behavior is selected by keywords
 * in the user's message:
 *
 * - `approve`: a shell command needing approval; accept runs it, decline fails it.
 * - `patch`: a file edit needing approval, reported as an ACP diff; nothing is written to disk.
 * - `question`: an `_x.ai/ask_user_question` request (one single-select and one multi-select question); the reply quotes
 *   the answers. Like Grok Build, `session/cancel` stops the turn without answering the pending question.
 * - `slow`: a thought, a running command, and a long streamed reply that `session/cancel` can stop.
 * - `fail`: the prompt fails with a provider error.
 * - `crash`: the process exits mid-turn.
 * - `/compact`: a compaction reply.
 * - Anything else: a thought, a plan, and a streamed reply quoting the message, naming the current model once switched.
 *
 * `session/set_model` switches between the two listed models.
 *
 * An `_x.ai/interject` during `slow` is quoted in the rest of the reply. Sessions persist to `FAKE_GROK_STATE_DIR` (or
 * the OS temp directory) as their update list, so `session/load` replays real history. Each session open appends its
 * method and the process arguments to `session-opens.jsonl` there, so tests can assert what Caxri asked for.
 *
 * Mirrors the shapes a real Grok Build 1.0.50 agent emitted in a content-free protocol probe: `_meta.availableCommands`
 * on `initialize`, `_x.ai/*` process notifications, replayed frames marked `_meta.isReplay` with their original
 * `_meta.agentTimestampMs`, and `turn_completed` on `_x.ai/session/update` when replayed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import { forkSession, rewindExecute, rewindPoints } from './fake-grok-rewind.ts';

interface RpcMessage {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}
interface StoredFrame {
    method: string;
    update: Record<string, unknown>;
    /**
     * When the frame was emitted, replayed as `_meta.agentTimestampMs` like Grok Build's own records.
     */
    at?: number;
}
interface FakeSession {
    id: string;
    frames: StoredFrame[];
}
interface PromptState {
    cancelled: boolean;
    interjections: string[];
}

if (process.argv.includes('--version')) {
    process.stdout.write('grok 1.0.50 (fake)\n');
    exitProcess(0);
}

const stateDirectory = process.env.FAKE_GROK_STATE_DIR ?? path.join(os.tmpdir(), 'caxri-fake-grok');
fs.mkdirSync(stateDirectory, { recursive: true });

/**
 * This file stands in for a CLI process, so exiting is part of its contract.
 */
function exitProcess(code: number): never {
    // eslint-disable-next-line unicorn/no-process-exit -- see above
    process.exit(code);
}

const state: {
    session?: FakeSession;
    prompt?: PromptState;
    nextRequestId: number;
    model: string;
} = {
    nextRequestId: 1,
    model: 'grok-fake',
};
const MODELS = [
    { modelId: 'grok-fake', name: 'Grok Fake', _meta: { totalContextTokens: 256_000 } },
    {
        modelId: 'grok-fake-fast',
        name: 'Grok Fake Fast',
        description: 'Faster replies',
        _meta: { totalContextTokens: 128_000 },
    },
];
const pendingRequests = new Map<number, (result: unknown) => void>();

function send(message: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function respond(id: number | string | undefined, result: unknown) {
    send({ id, result });
}
function respondError(
    id: number | string | undefined,
    code: number,
    message: string,
    data?: unknown,
) {
    send({ id, error: { code, message, ...(data !== undefined && { data }) } });
}
function sessionPath(id: string) {
    return path.join(stateDirectory, `${id.replaceAll(/[^\w-]/gu, '_')}.json`);
}
function currentSession(): FakeSession {
    if (!state.session) throw new Error('No session is open.');
    return state.session;
}
function save() {
    const session = currentSession();
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(session));
}
/**
 * Emits one conversation update and records it for replay, as Grok Build persists its `updates.jsonl`.
 */
function update(sessionUpdate: Record<string, unknown>) {
    const session = currentSession();
    session.frames.push({ method: 'session/update', update: sessionUpdate, at: Date.now() });
    send({ method: 'session/update', params: { sessionId: session.id, update: sessionUpdate } });
}
function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function request(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const id = state.nextRequestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, resolve);
        send({ id, method, params: parameters });
    });
}
function recordOpen(method: string) {
    fs.appendFileSync(
        path.join(stateDirectory, 'session-opens.jsonl'),
        `${JSON.stringify({ method, args: process.argv.slice(2) })}\n`,
    );
}

async function streamText(
    kind: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
    chunk = 12,
    pause = 0,
) {
    for (let index = 0; index < text.length; index += chunk) {
        if (state.prompt?.cancelled) return;
        update({
            sessionUpdate: kind,
            content: { type: 'text', text: text.slice(index, index + chunk) },
        });
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        if (pause > 0) await delay(pause);
    }
}

async function wasShellCallApproved(
    command: string,
    isApprovalRequired: boolean,
): Promise<boolean> {
    const session = currentSession();
    const toolCallId = `call-${crypto.randomUUID()}`;
    const rawInput = { variant: 'Bash', command, description: `Run ${command}` };
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Bash',
        kind: 'other',
        status: 'pending',
        rawInput,
    });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: `Execute \`${command}\``,
        kind: 'execute',
        rawInput,
        content: [{ type: 'content', content: { type: 'text', text: `Run ${command}` } }],
    });
    if (isApprovalRequired) {
        const result = (await request('session/request_permission', {
            sessionId: session.id,
            toolCall: { toolCallId, title: `Execute \`${command}\``, kind: 'execute', rawInput },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
        })) as { outcome?: { outcome?: string; optionId?: string } };
        // A `cancelled` outcome stops the turn, whether or not `session/cancel` has arrived yet.
        if (result.outcome?.outcome === 'cancelled' && state.prompt) state.prompt.cancelled = true;
        if (
            result.outcome?.optionId !== 'allow-once' &&
            result.outcome?.optionId !== 'always-allow'
        ) {
            update({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: 'failed',
                content: rejectedContent('run_terminal_command'),
            });
            return false;
        }
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `${command}: ok` } }],
    });
    return true;
}

/**
 * The content Grok Build reports for a tool call the user rejected, live and again in its `session/load` replay, where
 * the call's status is `failed` like a call that broke. Verified against Grok Build 1.0.50 for `run_terminal_command`;
 * the file-edit tool's name is this fixture's stand-in.
 */
function rejectedContent(tool: string): unknown[] {
    return [
        {
            type: 'content',
            content: { type: 'text', text: `User rejected the execution for tool \`${tool}\`` },
        },
    ];
}

async function wasPatchApproved(): Promise<boolean> {
    const session = currentSession();
    const toolCallId = `call-${crypto.randomUUID()}`;
    const diff = {
        type: 'diff',
        path: path.join(process.cwd(), 'src', 'app.ts'),
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\n',
    };
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Edit',
        kind: 'other',
        status: 'pending',
        rawInput: {},
    });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        content: [diff],
    });
    const result = (await request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId, kind: 'edit', content: [diff] },
        options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
    })) as { outcome?: { optionId?: string } };
    const isAccepted = result.outcome?.optionId === 'allow-once';
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: isAccepted ? 'completed' : 'failed',
        ...(!isAccepted && { content: rejectedContent('search_replace') }),
    });
    return isAccepted;
}

/**
 * Asks Grok Build's extension question and resolves with its answers, or `undefined` once the turn is cancelled: Grok
 * Build stops the turn on `session/cancel` and ignores a later answer.
 */
async function askQuestions(): Promise<Record<string, unknown> | undefined> {
    const session = currentSession();
    const answer = request('_x.ai/ask_user_question', {
        sessionId: session.id,
        toolCallId: `call-${crypto.randomUUID()}`,
        questions: [
            {
                question: 'Which color?',
                options: [
                    { label: 'Red', description: 'Warm' },
                    { label: 'Blue', description: 'Cool' },
                ],
                multiSelect: false,
            },
            {
                question: 'Which sizes?',
                options: [
                    { label: 'Small', description: '' },
                    { label: 'Large', description: '' },
                ],
                multiSelect: true,
            },
        ],
        mode: 'default',
    }) as Promise<{ outcome?: string; answers?: Record<string, unknown> }>;
    const cancelled = new Promise<undefined>((resolve) => {
        const timer = setInterval(() => {
            if (!state.prompt?.cancelled) return;
            clearInterval(timer);
            resolve(undefined);
        }, 20);
        // eslint-disable-next-line no-void -- the poll only needs to stop once the answer arrives
        void answer.then(() => clearInterval(timer));
    });
    const result = await Promise.race([answer, cancelled]);
    if (!result) return undefined;
    if (result.outcome === 'accepted') return result.answers ?? {};
    // Caxri answers `cancelled` just before `session/cancel` when the user stops the turn.
    await delay(50);
    return state.prompt?.cancelled ? undefined : {};
}

async function runPrompt(id: number | string | undefined, text: string) {
    const session = currentSession();
    const prompt: PromptState = { cancelled: false, interjections: [] };
    state.prompt = prompt;
    session.frames.push({
        method: 'session/update',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        at: Date.now(),
    });
    const startedAt = Date.now();
    const finish = (stopReason: string) => {
        state.prompt = undefined;
        session.frames.push({
            at: Date.now(),
            method: '_x.ai/session/update',
            update: {
                sessionUpdate: 'turn_completed',
                stop_reason: stopReason,
                elapsed_ms: Date.now() - startedAt,
            },
        });
        save();
        send({
            method: '_x.ai/session_notification',
            params: {
                sessionId: session.id,
                update: { sessionUpdate: 'turn_completed', stop_reason: stopReason },
            },
        });
        respond(id, { stopReason, _meta: { totalTokens: 1200 + text.length } });
    };
    if (text.includes('crash')) {
        await streamText('agent_message_chunk', 'About to stop.');
        exitProcess(3);
    }
    if (text.includes('fail')) {
        save();
        state.prompt = undefined;
        respondError(id, -32000, 'The model request failed');
        return;
    }
    if (text.startsWith('/compact')) {
        await streamText('agent_message_chunk', 'Conversation compacted.');
        finish('end_turn');
        return;
    }
    await streamText('agent_thought_chunk', 'Thinking about the request.');
    if (text.includes('approve')) {
        const ran = await wasShellCallApproved('npm test', true);
        await streamText(
            'agent_message_chunk',
            ran ? 'The command ran.' : 'The command was declined.',
        );
        // Like Grok Build, a turn blocked on an approval only ends once that request is answered.
        finish(prompt.cancelled ? 'cancelled' : 'end_turn');
        return;
    }
    if (text.includes('question')) {
        const answers = await askQuestions();
        if (!answers) {
            finish('cancelled');
            return;
        }
        await streamText(
            'agent_message_chunk',
            Object.keys(answers).length > 0
                ? `Answers: ${JSON.stringify(answers)}`
                : 'The question was skipped.',
        );
        finish('end_turn');
        return;
    }
    if (text.includes('patch')) {
        const applied = await wasPatchApproved();
        await streamText(
            'agent_message_chunk',
            applied ? 'The edit was applied.' : 'The edit was declined.',
        );
        finish('end_turn');
        return;
    }
    if (text.includes('slow')) {
        await wasShellCallApproved('sleep 1', false);
        for (let index = 0; index < 200 && !prompt.cancelled; index += 1) {
            const heard = prompt.interjections.shift();
            // eslint-disable-next-line no-await-in-loop -- the turn streams until it is cancelled
            await streamText(
                'agent_message_chunk',
                heard ? `Heard: ${heard}. ` : 'Still working. ',
                64,
                0,
            );
            // eslint-disable-next-line no-await-in-loop -- paced so a cancel or interject lands mid-turn
            await delay(25);
        }
        finish(prompt.cancelled ? 'cancelled' : 'end_turn');
        return;
    }
    update({
        sessionUpdate: 'plan',
        entries: [
            { content: 'Read the request', priority: 'high', status: 'completed' },
            { content: 'Reply', priority: 'medium', status: 'in_progress' },
        ],
    });
    await streamText(
        'agent_message_chunk',
        state.model === MODELS[0].modelId
            ? `You said: ${text}`
            : `You said: ${text} (${state.model})`,
    );
    finish('end_turn');
}

function openSession(id: number | string | undefined, sessionId: string) {
    state.session = { id: sessionId, frames: [] };
    respond(id, {
        sessionId,
        models: { currentModelId: state.model, availableModels: MODELS },
    });
    send({
        method: 'session/update',
        params: {
            sessionId,
            update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                    { name: 'compact', description: 'Compress conversation history', input: null },
                    { name: 'review', description: 'Review changes', input: { hint: '<target>' } },
                ],
            },
        },
    });
}

function handle(message: RpcMessage) {
    if (message.method === undefined) {
        if (typeof message.id === 'number') {
            const resolve = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            resolve?.(message.result ?? {});
        }
        return;
    }
    const parameters = message.params ?? {};
    switch (message.method) {
        case 'initialize': {
            respond(message.id, {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { image: false, embeddedContext: true },
                },
                authMethods: [],
                _meta: {
                    agentVersion: '1.0.50',
                    availableCommands: [
                        {
                            name: 'compact',
                            description: 'Compress conversation history',
                            input: null,
                        },
                    ],
                },
            });
            // Process-wide extension traffic a real agent sends, plus a response to its own internal request.
            send({
                method: '_x.ai/models/update',
                params: { currentModelId: 'grok-fake', availableModels: [] },
            });
            send({ id: 'skills-reload', result: { result: { reloaded: 0 } } });
            return;
        }
        case 'session/new': {
            const meta = (parameters._meta ?? {}) as Record<string, unknown>;
            const sessionId =
                typeof meta.sessionId === 'string' ? meta.sessionId : crypto.randomUUID();
            recordOpen('session/new');
            openSession(message.id, sessionId);
            save();
            return;
        }
        case 'session/load': {
            const sessionId = String(parameters.sessionId);
            recordOpen('session/load');
            if (!fs.existsSync(sessionPath(sessionId))) {
                respondError(message.id, -32603, 'Path not found.', { code: 'FS_NOT_FOUND' });
                return;
            }
            const stored = JSON.parse(
                fs.readFileSync(sessionPath(sessionId), 'utf8'),
            ) as FakeSession;
            for (const frame of stored.frames)
                send({
                    method: frame.method,
                    params: {
                        sessionId,
                        update: frame.update,
                        _meta: {
                            isReplay: true,
                            ...(frame.at !== undefined && { agentTimestampMs: frame.at }),
                        },
                    },
                });
            const id = message.id;
            openSession(id, sessionId);
            currentSession().frames = stored.frames;
            return;
        }
        case 'session/prompt': {
            const blocks = Array.isArray(parameters.prompt) ? parameters.prompt : [];
            const text = blocks
                .map((block: { type?: string; text?: string }) =>
                    block.type === 'text' ? (block.text ?? '') : '',
                )
                .join('');
            // eslint-disable-next-line no-void -- the turn streams its own updates before the prompt resolves
            void runPrompt(message.id, text);
            return;
        }
        case '_x.ai/interject': {
            if (!state.prompt) {
                respondError(message.id, -32602, 'No turn is running');
                return;
            }
            state.prompt.interjections.push(String(parameters.text));
            respond(message.id, {});
            return;
        }
        case 'session/set_model': {
            const modelId = String(parameters.modelId);
            if (MODELS.every((model) => model.modelId !== modelId)) {
                respondError(message.id, -32602, `Unknown model ${modelId}`);
                return;
            }
            state.model = modelId;
            respond(message.id, { _meta: { model: { Ok: null } } });
            return;
        }
        case '_x.ai/rewind/points': {
            respond(message.id, rewindPoints(currentSession().frames));
            return;
        }
        case '_x.ai/rewind/execute': {
            respond(
                message.id,
                rewindExecute(currentSession(), parameters, {
                    isPromptRunning: state.prompt !== undefined,
                    stateDirectory,
                    save,
                }),
            );
            return;
        }
        case '_x.ai/session/fork': {
            send({ id: message.id, ...forkSession(parameters, { stateDirectory, sessionPath }) });
            return;
        }
        case 'session/cancel': {
            if (state.prompt) state.prompt.cancelled = true;
            return;
        }
        default: {
            if (message.id !== undefined)
                respondError(message.id, -32601, `Unknown method ${message.method}`);
        }
    }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
    if (!line.trim()) return;
    handle(JSON.parse(line) as RpcMessage);
});
lines.on('close', () => exitProcess(0));
