/**
 * Deterministic stand-in for `agy acp` (ACP over newline-delimited JSON-RPC), used by Agent Chat tests so no test ever
 * launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a `run_command` tool call that asks first; allowing it runs it, rejecting it leaves it unrun.
 * - `read`: a `view_file` tool call that runs without asking.
 * - `slow`: a long streamed reply that `session/cancel` can stop.
 * - Anything else: a thought and a reply quoting the message, naming the current model and thinking level.
 *
 * The agent picks the session id in `session/new`, as Antigravity does, and reports its model and thinking level only
 * through `configOptions`, which `session/set_config_option` changes. Sessions persist to `FAKE_ANTIGRAVITY_STATE_DIR`
 * (or the OS temp directory) as their update list, so `session/load` replays real history; each session open appends
 * its method and the process arguments to `session-opens.jsonl` there.
 *
 * Mirrors the shapes `agy` 1.4.11 emitted in a content-free protocol probe: no `promptCapabilities`, tool calls named
 * by Antigravity's own identifiers in a non-standard `name`, PascalCase tool input, and `usage.totalTokens` on the
 * `session/prompt` result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

interface RpcMessage {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
}

const stateDirectory =
    process.env.FAKE_ANTIGRAVITY_STATE_DIR ?? path.join(os.tmpdir(), 'caxri-fake-antigravity');
fs.mkdirSync(stateDirectory, { recursive: true });

const MODELS = [
    { value: 'gemini-fake-flash', name: 'Gemini Fake Flash' },
    { value: 'gemini-fake-pro', name: 'Gemini Fake Pro' },
];
const LEVELS = ['low', 'medium', 'high'];

const state: {
    sessionId?: string;
    updates: Array<Record<string, unknown>>;
    model: string;
    level: string;
    cancelled: boolean;
    nextRequestId: number;
} = {
    updates: [],
    model: 'gemini-fake-flash',
    level: 'high',
    cancelled: false,
    nextRequestId: 1,
};
const pending = new Map<number | string, (result: unknown) => void>();

function write(message: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sessionPath(sessionId: string): string {
    return path.join(stateDirectory, `${sessionId}.json`);
}

function configOptions(): Array<Record<string, unknown>> {
    return [
        {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: state.model,
            options: MODELS,
        },
        {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: state.level,
            options: LEVELS.map((value) => ({ value, name: value })),
        },
    ];
}

function update(sessionUpdate: Record<string, unknown>, shouldRecord = true): void {
    if (shouldRecord) state.updates.push(sessionUpdate);
    write({
        method: 'session/update',
        params: { sessionId: state.sessionId, update: sessionUpdate },
    });
}

function persist(): void {
    if (state.sessionId)
        fs.writeFileSync(sessionPath(state.sessionId), JSON.stringify(state.updates));
}

function recordOpen(method: string): void {
    fs.appendFileSync(
        path.join(stateDirectory, 'session-opens.jsonl'),
        `${JSON.stringify({ method, args: process.argv.slice(2) })}\n`,
    );
}

function request(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const id = `agent-${state.nextRequestId++}`;
    write({ id, method, params: parameters });
    return new Promise((resolve) => pending.set(id, resolve));
}

/**
 * Read through a call so a cancel that lands during an `await` is not narrowed away.
 */
const isCancelled = () => state.cancelled;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function didRunCommand(command: string): Promise<boolean> {
    const toolCallId = crypto.randomUUID();
    const call = {
        toolCallId,
        name: 'run_command',
        title: command,
        kind: 'execute',
        rawInput: { CommandLine: command, Cwd: process.cwd() },
    };
    update({ sessionUpdate: 'tool_call', ...call, status: 'pending' });
    const result = (await request('session/request_permission', {
        sessionId: state.sessionId,
        toolCall: call,
        options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
    })) as { outcome?: { outcome?: string; optionId?: string } };
    if (result.outcome?.outcome === 'cancelled') state.cancelled = true;
    const isAllowed = ['allow', 'allow-always'].includes(result.outcome?.optionId ?? '');
    // Like `agy`, a rejected command goes back to `in_progress` and is never run.
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: isAllowed ? 'completed' : 'in_progress',
        ...(isAllowed && {
            content: [{ type: 'content', content: { type: 'text', text: `${command}: ok` } }],
        }),
    });
    return isAllowed;
}

async function prompt(text: string): Promise<Record<string, unknown>> {
    state.cancelled = false;
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    let reply: string;
    if (text.includes('approve')) {
        reply = (await didRunCommand('npm test')) ? 'The command ran.' : 'The command did not run.';
    } else if (text.includes('read')) {
        const toolCallId = crypto.randomUUID();
        const file = path.join(process.cwd(), 'README.md');
        update({
            sessionUpdate: 'tool_call',
            toolCallId,
            name: 'view_file',
            title: 'Read README.md',
            kind: 'read',
            status: 'in_progress',
            rawInput: { AbsolutePath: file },
        });
        update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
        reply = 'Read it.';
    } else if (text.includes('slow')) {
        for (let index = 0; index < 200 && !isCancelled(); index += 1) {
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } });
            // eslint-disable-next-line no-await-in-loop -- paced so a cancel lands mid-turn
            await delay(20);
        }
        persist();
        return { stopReason: isCancelled() ? 'cancelled' : 'end_turn' };
    } else {
        update({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Thinking about the request.' },
        });
        reply = `You said: ${text} (${state.model}, ${state.level})`;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
    persist();
    return {
        stopReason: isCancelled() ? 'cancelled' : 'end_turn',
        usage: { totalTokens: 900, inputTokens: 800, outputTokens: 100 },
    };
}

async function handle(message: RpcMessage): Promise<unknown> {
    const parameters = message.params ?? {};
    switch (message.method) {
        case 'initialize': {
            return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: 'antigravity', version: '1.4.11-fake' },
                _meta: { antigravity: { systemPrompt: { append: true } } },
            };
        }
        case 'session/new': {
            recordOpen('session/new');
            state.sessionId = crypto.randomUUID();
            state.updates = [];
            persist();
            return { sessionId: state.sessionId, configOptions: configOptions() };
        }
        case 'session/load': {
            recordOpen('session/load');
            const sessionId = String(parameters.sessionId);
            if (!fs.existsSync(sessionPath(sessionId))) throw new Error('Conversation not found');
            state.sessionId = sessionId;
            state.updates = JSON.parse(fs.readFileSync(sessionPath(sessionId), 'utf8')) as Array<
                Record<string, unknown>
            >;
            for (const recorded of state.updates) update(recorded, false);
            return { configOptions: configOptions() };
        }
        case 'session/prompt': {
            const blocks = Array.isArray(parameters.prompt)
                ? (parameters.prompt as Array<{ type?: string; text?: string }>)
                : [];
            return prompt(
                blocks
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text ?? '')
                    .join(''),
            );
        }
        case 'session/set_config_option': {
            const value = String(parameters.value);
            if (parameters.configId === 'model' && MODELS.some((model) => model.value === value))
                state.model = value;
            else if (parameters.configId === 'thought_level' && LEVELS.includes(value))
                state.level = value;
            else throw new Error(`Unknown option ${String(parameters.configId)}=${value}`);
            return { configOptions: configOptions() };
        }
        default: {
            throw new Error(`Method not found: ${String(message.method)}`);
        }
    }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as RpcMessage;
    if (message.method === undefined && message.id !== undefined) {
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
        return;
    }
    if (message.method === 'session/cancel') {
        state.cancelled = true;
        for (const [id, resolve] of pending) {
            resolve({ outcome: { outcome: 'cancelled' } });
            pending.delete(id);
        }
        return;
    }
    if (message.id === undefined) return;
    void reply(message.id, message);
});

async function reply(id: number | string, message: RpcMessage): Promise<void> {
    try {
        write({ id, result: await handle(message) });
    } catch (error) {
        write({
            id,
            error: {
                code: -32_603,
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
lines.on('close', () => persist());
