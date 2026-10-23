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
 * `session/set_model` switches between the two listed models; the first lists reasoning efforts, which
 * `session/set_config_option` (`reasoning_effort`) switches and reports back through `configOptions`.
 *
 * An `_x.ai/interject` during `slow` is quoted in the rest of the reply. Sessions persist to `FAKE_GROK_STATE_DIR` (or
 * the OS temp directory) as their update list, so `session/load` replays real history, one merged `tool_call` frame per
 * tool call like Grok Build (`fake-grok-replay.ts`). Each session open appends its method and the process arguments to
 * `session-opens.jsonl` there, so tests can assert what Caxri asked for.
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

import type { StoredFrame } from './fake-grok-replay.ts';
import { replayFrames } from './fake-grok-replay.ts';
import { forkSession, rewindExecute, rewindPoints } from './fake-grok-rewind.ts';
import type { FakeGrokTurn, PromptState } from './fake-grok-tools.ts';
import { askQuestions, delay, wasPatchApproved, wasShellCallApproved } from './fake-grok-tools.ts';

interface RpcMessage {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}
interface FakeSession {
    id: string;
    frames: StoredFrame[];
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
    effort: string;
} = {
    nextRequestId: 1,
    model: 'grok-fake',
    effort: 'high',
};
/**
 * Reasoning efforts as Grok Build 1.0.62 lists them in a model's `_meta`: highest first, with the default named apart.
 */
const EFFORT_META = {
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'].map((id) => ({
        id,
        value: id,
        label: id,
        default: id === 'high',
    })),
};
const MODELS = [
    {
        modelId: 'grok-fake',
        name: 'Grok Fake',
        _meta: { totalContextTokens: 256_000, ...EFFORT_META },
    },
    {
        modelId: 'grok-fake-fast',
        name: 'Grok Fake Fast',
        description: 'Faster replies',
        _meta: { totalContextTokens: 128_000 },
    },
];
/**
 * The `configOptions` a session reports, as Grok Build 1.0.62 does: the model and `reasoning_effort` selects.
 */
function configOptions() {
    return [
        {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: state.model,
            options: MODELS.map((model) => ({ value: model.modelId, name: model.name })),
        },
        {
            id: 'reasoning_effort',
            name: 'Reasoning Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: state.effort,
            options: EFFORT_META.reasoningEfforts.map((effort) => ({
                value: effort.id,
                name: effort.label,
            })),
        },
    ];
}
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

async function runPrompt(id: number | string | undefined, text: string, promptId?: string) {
    const session = currentSession();
    const prompt: PromptState = { cancelled: false, interjections: [] };
    state.prompt = prompt;
    const turn: FakeGrokTurn = { sessionId: session.id, prompt, update, request };
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
                ...(promptId && { prompt_id: promptId }),
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
        const ran = await wasShellCallApproved(turn, 'npm test', true);
        await streamText(
            'agent_message_chunk',
            ran ? 'The command ran.' : 'The command was declined.',
        );
        // Like Grok Build, a turn blocked on an approval only ends once that request is answered.
        finish(prompt.cancelled ? 'cancelled' : 'end_turn');
        return;
    }
    if (text.includes('question')) {
        const answers = await askQuestions(turn);
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
        const applied = await wasPatchApproved(turn);
        await streamText(
            'agent_message_chunk',
            applied ? 'The edit was applied.' : 'The edit was declined.',
        );
        finish('end_turn');
        return;
    }
    if (text.includes('slow')) {
        await wasShellCallApproved(turn, 'sleep 1', false);
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
        configOptions: configOptions(),
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
            for (const frame of replayFrames(stored.frames))
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
            const meta = (parameters._meta ?? {}) as Record<string, unknown>;
            const promptId = typeof meta.promptId === 'string' ? meta.promptId : undefined;
            void runPrompt(message.id, text, promptId);
            return;
        }
        case '_x.ai/interject': {
            if (!state.prompt) {
                respondError(message.id, -32602, 'No turn is running');
                return;
            }
            state.prompt.interjections.push(String(parameters.text));
            // Like Grok Build 1.0.62, the interjection is recorded as a user message wrapped for the model, with what the
            // user typed in `_meta.displayText`. It is not a prompt: `_x.ai/rewind/points` does not list it.
            currentSession().frames.push({
                method: 'session/update',
                update: {
                    sessionUpdate: 'user_message_chunk',
                    content: {
                        type: 'text',
                        text: `The user sent a message while you were working: ${String(parameters.text)}`,
                        _meta: { displayText: String(parameters.text) },
                    },
                },
                at: Date.now(),
            });
            respond(message.id, { status: 'queued' });
            return;
        }
        case 'session/set_config_option': {
            const value = String(parameters.value);
            const efforts = EFFORT_META.reasoningEfforts.map((effort) => effort.id);
            if (parameters.configId !== 'reasoning_effort' || !efforts.includes(value)) {
                respondError(
                    message.id,
                    -32602,
                    'Invalid params',
                    'unknown reasoning_effort value',
                );
                return;
            }
            state.effort = value;
            fs.appendFileSync(
                path.join(stateDirectory, 'effort-changes.jsonl'),
                `${JSON.stringify({ effort: value })}\n`,
            );
            respond(message.id, { configOptions: configOptions() });
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
