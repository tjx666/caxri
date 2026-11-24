/**
 * Deterministic stand-in for `agy acp` (ACP over newline-delimited JSON-RPC), used by Agent Chat tests so no test ever
 * launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a `run_command` tool call that asks first; allowing it runs it, rejecting it leaves it unrun.
 * - `read`: a `view_file` tool call that runs without asking.
 * - `background`: a command `agy` moved to the background (see `startBackgroundCommand`); with `late`, the prompt answers
 *   `end_turn` 300 ms after its reply even when a Stop arrived meanwhile, as `agy` does for a prompt it had already
 *   ended.
 * - `slow`: a long streamed reply that `session/cancel` can stop, or a later `session/prompt` ends with `end_turn` (how
 *   `agy` takes a message steered into a running turn).
 * - `plan`: in the `plan` session mode, a `write_file` of a plan artifact that requests the user's feedback.
 * - `quota`: a failed prompt with Antigravity's used-up quota message.
 * - `session mode`: a reply naming the current session mode.
 * - Image blocks: a reply counting them.
 * - Anything else: a thought and a reply quoting the message, naming the current model and thinking level.
 *
 * Every finished prompt reports its context with a `usage_update`. Run as `models` instead, it prints the model list
 * `agy models` does and exits; run as `-p /usage`, it prints a signed-in `/usage` answer with Gemini's 5-hour window
 * 40% used and exits.
 *
 * The agent picks the session id in `session/new`, as Antigravity does, and reports its model and thinking level only
 * through `configOptions`, which `session/set_config_option` changes. Sessions persist to `FAKE_ANTIGRAVITY_STATE_DIR`
 * (or the OS temp directory) as their update list, so `session/load` replays real history; each session open appends
 * its method and the process arguments to `session-opens.jsonl` there. Each conversation is also written as `agy`'s own
 * database (see `writeConversation`), and `session/load` of a conversation with no update list (a copy Server Core made
 * for "Edit from here" or "Fork from here") replays the prompts that database kept.
 *
 * Mirrors the shapes `agy` 1.5.14 emitted in a content-free protocol probe: image `promptCapabilities`, the
 * `default`/`accept-edits`/`auto`/`plan` session modes, tool calls named by Antigravity's own identifiers in a
 * non-standard `name`, PascalCase tool input, and `usage.totalTokens` on the `session/prompt` result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

import {
    encodeMessage,
    varint,
} from '../../../agents/providers/antigravity/__tests__/fixtures/protobuf-encode.ts';
import { askQuestions } from './fake-antigravity-questions.ts';

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
    mode: string;
    cancelled: boolean;
    /**
     * Counts `session/prompt` requests, so a running one sees a later one supersede it.
     */
    prompts: number;
    nextRequestId: number;
    /**
     * Whether `initialize` advertised `elicitation.form`; like `agy` 1.5.16, the fake asks no question without it.
     */
    canElicit?: boolean;
} = {
    updates: [],
    model: 'gemini-fake-flash',
    level: 'high',
    mode: 'default',
    cancelled: false,
    prompts: 0,
    nextRequestId: 1,
};

const MODES = ['default', 'accept-edits', 'auto', 'plan'];
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

/**
 * The home whose `.gemini/antigravity-cli/conversations` gets a copy of each conversation in `agy`'s own database
 * layout, which Server Core copies and cuts for "Edit from here" and "Fork from here": `FAKE_ANTIGRAVITY_HOME`. Without
 * it nothing is written there, so a test never touches a real home.
 */
const conversationHome = process.env.FAKE_ANTIGRAVITY_HOME;

function conversationPath(sessionId: string): string | undefined {
    return conversationHome
        ? path.join(
              conversationHome,
              '.gemini',
              'antigravity-cli',
              'conversations',
              `${sessionId}.db`,
          )
        : undefined;
}

/**
 * The update list split into prompts: each `user_message_chunk` starts one, as each prompt is one user step in `agy`.
 */
function promptsOf(
    updates: ReadonlyArray<Record<string, unknown>>,
): Array<{ text: string; updates: Array<Record<string, unknown>> }> {
    const prompts: Array<{ text: string; updates: Array<Record<string, unknown>> }> = [];
    for (const recorded of updates) {
        if (recorded.sessionUpdate === 'user_message_chunk') {
            const content = recorded.content as { text?: string } | undefined;
            prompts.push({ text: content?.text ?? '', updates: [] });
        }
        // Updates before the first prompt have no step to belong to; `agy` records none.
        prompts.at(-1)?.updates.push(recorded);
    }
    return prompts;
}

/**
 * Writes the conversation as `agy` 1.5.14's database: its tables, one user step per prompt with the prompt in
 * `gemini_coder.Step.user_input.query`, and a fake-only `fake_updates` column holding the prompt's updates, so a cut
 * copy replays exactly the prompts it kept.
 */
function writeConversation(sessionId: string): void {
    const target = conversationPath(sessionId);
    if (!target) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.fake-partial`;
    fs.rmSync(partial, { force: true });
    const database = new DatabaseSync(partial);
    try {
        database.exec(`
            CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer,
                source integer, PRIMARY KEY (trajectory_id));
            CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
                has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob,
                permissions blob, task_details blob, render_info blob, step_payload blob,
                step_format integer NOT NULL DEFAULT 0, fake_updates text, PRIMARY KEY (idx));
            CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
            CREATE TABLE executor_metadata (idx integer, data blob, PRIMARY KEY (idx));
        `);
        database
            .prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)')
            .run(crypto.randomUUID(), sessionId);
        const step = database.prepare(
            'INSERT INTO steps (idx, step_type, status, metadata, step_payload, fake_updates) VALUES (?, 14, 3, ?, ?, ?)',
        );
        const generation = database.prepare(
            'INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)',
        );
        // Each step's time, which dates its usage; a rewrite dates every step now, which a fake can afford.
        const metadata = encodeMessage([[1, [[1, Math.floor(Date.now() / 1000)]]]]);
        for (const [index, recorded] of promptsOf(state.updates).entries())
            step.run(
                index,
                metadata,
                encodeMessage([[19, [[1, recorded.text]]]]),
                JSON.stringify(recorded.updates),
            );
        // Each prompt's token usage, as the `session/prompt` result reports it, so Usage and the status bar read this
        // conversation as they read a real one.
        for (const index of promptsOf(state.updates).keys()) {
            const usage = encodeMessage([
                [
                    1,
                    [
                        [
                            4,
                            [
                                [1, 1318],
                                [2, 800],
                                [3, 100],
                            ],
                        ],
                        [19, state.model],
                    ],
                ],
                [2, Uint8Array.from(varint(index))],
            ]);
            generation.run(index, usage, usage.length);
        }
    } finally {
        database.close();
    }
    fs.renameSync(partial, target);
}

/**
 * The updates of a conversation only the database holds: one Server Core copied, which has no update list yet.
 */
function readConversation(sessionId: string): Array<Record<string, unknown>> | undefined {
    const source = conversationPath(sessionId);
    if (!source || !fs.existsSync(source)) return undefined;
    const database = new DatabaseSync(source, { readOnly: true });
    try {
        const rows = database
            .prepare('SELECT fake_updates FROM steps ORDER BY idx')
            .all() as Array<{
            fake_updates: string;
        }>;
        return rows.flatMap(
            (row) => JSON.parse(row.fake_updates) as Array<Record<string, unknown>>,
        );
    } finally {
        database.close();
    }
}

function persist(): void {
    if (!state.sessionId) return;
    fs.writeFileSync(sessionPath(state.sessionId), JSON.stringify(state.updates));
    writeConversation(state.sessionId);
}

function recordOpen(method: string, meta: unknown): void {
    fs.appendFileSync(
        path.join(stateDirectory, 'session-opens.jsonl'),
        `${JSON.stringify({ method, args: process.argv.slice(2), meta })}\n`,
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

/**
 * Like `agy` 1.5 moving a slow foreground command to the background: the prompt ends while the command still runs, and
 * the command reports finished afterwards. A `daemon` command is started as one (`IsDaemon`), and a `forever` one never
 * finishes; neither reports an end.
 */
function startBackgroundCommand(text: string): void {
    const toolCallId = crypto.randomUUID();
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        name: 'run_command',
        title: 'npm run build',
        kind: 'execute',
        status: 'in_progress',
        rawInput: {
            CommandLine: 'npm run build',
            Cwd: process.cwd(),
            IsDaemon: text.includes('daemon'),
        },
    });
    if (text.includes('daemon') || text.includes('forever')) return;
    setTimeout(() => {
        update({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'built' } }],
        });
    }, 300);
}

function writePlan(): void {
    const toolCallId = crypto.randomUUID();
    const rawInput = {
        Path: path.join(process.cwd(), 'plan.md'),
        Content: '# Plan\n\n1. Do it\n',
        ArtifactMetadata: { RequestFeedback: true, Summary: 'The plan', UserFacing: true },
    };
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        name: 'write_file',
        title: 'File plan.md',
        kind: 'edit',
        status: 'in_progress',
        rawInput,
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
}

async function prompt(text: string, images: number): Promise<Record<string, unknown>> {
    state.cancelled = false;
    state.prompts += 1;
    const turn = state.prompts;
    const isSuperseded = () => state.prompts !== turn;
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    if (text.includes('quota')) throw new Error('You have exhausted your quota on this model.');
    let reply: string;
    if (images > 0) {
        reply = `Saw ${images} image${images === 1 ? '' : 's'}`;
    } else if (text.includes('session mode')) {
        reply = `Mode: ${state.mode}`;
    } else if (text.includes('plan') && state.mode === 'plan') {
        writePlan();
        reply = 'Review the plan.';
    } else if (text.includes('question')) {
        reply = await askQuestions({
            sessionId: state.sessionId,
            canElicit: state.canElicit ?? false,
            update,
            request,
        });
    } else if (text.includes('approve')) {
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
    } else if (text.includes('background')) {
        startBackgroundCommand(text);
        reply = 'Started the build.';
    } else if (text.includes('stuck')) {
        // A command that never reports its end while the prompt itself still runs until Stop.
        startBackgroundCommand('forever');
        while (!isCancelled()) {
            // eslint-disable-next-line no-await-in-loop -- waits for the Stop the test sends
            await delay(20);
        }
        return { stopReason: 'cancelled' };
    } else if (text.includes('slow')) {
        for (let index = 0; index < 200 && !isCancelled() && !isSuperseded(); index += 1) {
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
    update({ sessionUpdate: 'usage_update', used: 850, size: 1_000_000 });
    persist();
    const isLate = text.includes('background') && text.includes('late');
    if (isLate) await delay(300);
    return {
        stopReason: !isLate && isCancelled() ? 'cancelled' : 'end_turn',
        usage: { totalTokens: 900, inputTokens: 800, outputTokens: 100 },
    };
}

async function handle(message: RpcMessage): Promise<unknown> {
    const parameters = message.params ?? {};
    switch (message.method) {
        case 'initialize': {
            // `FAKE_ANTIGRAVITY_VERSION` plays an older `agy`: before 1.5.0 it has no `acp` server and quits.
            const version = process.env.FAKE_ANTIGRAVITY_VERSION ?? '1.5.14-fake';
            // eslint-disable-next-line unicorn/no-process-exit -- this fake is the CLI process, quitting as old `agy` does
            if (version.startsWith('1.4.')) process.exit(2);
            const capabilities = parameters.clientCapabilities as
                { elicitation?: { form?: unknown } } | undefined;
            state.canElicit = capabilities?.elicitation?.form !== undefined;
            return {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { image: true, audio: true, embeddedContext: true },
                    // Where agy 1.5.14 advertises appending to its system prompt.
                    _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
                },
                agentInfo: { name: 'antigravity', version },
            };
        }
        case 'session/new': {
            recordOpen('session/new', parameters._meta);
            state.sessionId = crypto.randomUUID();
            state.updates = [];
            persist();
            return {
                sessionId: state.sessionId,
                configOptions: configOptions(),
                modes: {
                    currentModeId: state.mode,
                    availableModes: MODES.map((id) => ({ id, name: id })),
                },
            };
        }
        case 'session/set_mode': {
            const modeId = String(parameters.modeId);
            if (!MODES.includes(modeId)) throw new Error(`Unknown mode ${modeId}`);
            state.mode = modeId;
            update({ sessionUpdate: 'current_mode_update', currentModeId: modeId }, false);
            return {};
        }
        case 'session/load': {
            recordOpen('session/load', parameters._meta);
            const sessionId = String(parameters.sessionId);
            const updates = fs.existsSync(sessionPath(sessionId))
                ? (JSON.parse(fs.readFileSync(sessionPath(sessionId), 'utf8')) as Array<
                      Record<string, unknown>
                  >)
                : readConversation(sessionId);
            if (!updates) throw new Error('Conversation not found');
            state.sessionId = sessionId;
            state.updates = updates;
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
                blocks.filter((block) => block.type === 'image').length,
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

/**
 * `agy models`: a progress line, then one `<id>\t<name>` row per model and thinking level, as `agy` 1.5.14 prints them.
 */
function printModels(): void {
    const rows = MODELS.flatMap(({ value, name }) =>
        LEVELS.map(
            (level) =>
                `${value}-${level}\t${name} (${level.charAt(0).toUpperCase()}${level.slice(1)})`,
        ),
    );
    process.stdout.write(`Fetching models...\n${rows.join('\n')}\n`);
}

/**
 * `agy -p /usage --output-format json`: the shape `agy` 1.5.14 prints for a signed-in account.
 */
function printUsage(): void {
    const resetTime = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const buckets = [{ window: '5h', remaining_fraction: 0.6, reset_time: resetTime }];
    process.stdout.write(
        `${JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets }] } } })}\n`,
    );
}

if (process.argv[2] === 'models') printModels();
else if (process.argv[2] === '-p' && process.argv[3] === '/usage') printUsage();
else serve();

function serve(): void {
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', onLine);
    lines.on('close', () => persist());
}

function onLine(line: string): void {
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
}

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
