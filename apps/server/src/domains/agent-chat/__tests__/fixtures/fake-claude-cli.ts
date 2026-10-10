/**
 * Deterministic stand-in for `claude` driven by the Claude Agent SDK (`--input-format stream-json --output-format
 * stream-json --permission-prompt-tool=stdio`), used by Agent Chat unit tests and fake-mode E2E so no test ever
 * launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a Bash command needing approval; accept runs it, decline records it as declined.
 * - `edit`: a file edit needing approval; accept reports a structured patch.
 * - `ask`: an `AskUserQuestion` question; the reply quotes the chosen answer.
 * - `planmode`: an `ExitPlanMode` approval, the generic tool request kind that is neither a command nor a file edit.
 * - `slow`: a long streamed reply that an interrupt can stop.
 * - `pause`: a short reply streamed over about a second, long enough to send another message into the turn.
 * - `fail`: a failed turn with an error result.
 * - `crash`: the process exits mid-turn.
 * - `table`: a reply with a Markdown table and a fenced code block.
 * - Anything else: thinking, a todo list, and a streamed reply quoting the message.
 *
 * A message with images is answered with how many it received. `/compact` compacts the conversation; the CLI reports
 * `/compact`, `/review`, and the terminal-bound `/exit` as its commands.
 *
 * Every turn is appended to a JSONL transcript at Claude Code's own location under `CLAUDE_CONFIG_DIR`, so `--resume`
 * and Caxri's transcript-based history read real records.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

type Json = Record<string, unknown>;

const MODEL = 'fake-claude-model';

if (process.argv.includes('--version')) {
    process.stdout.write('2.1.0 (Claude Code)\n');
    exitProcess(0);
}

/**
 * This file stands in for a CLI process, so exiting is part of its contract.
 */
function exitProcess(code: number): never {
    // eslint-disable-next-line unicorn/no-process-exit -- see above
    process.exit(code);
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    if (index !== -1) return process.argv[index + 1];
    const prefixed = process.argv.find((value) => value.startsWith(`${name}=`));
    return prefixed?.slice(name.length + 1);
}

const resumeId = argument('--resume');
const sessionId = resumeId ?? argument('--session-id') ?? crypto.randomUUID();
const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const transcriptPath = path.join(
    configDirectory,
    'projects',
    process.cwd().replaceAll(/[^a-z0-9]/giu, '-'),
    `${sessionId}.jsonl`,
);

if (resumeId && !fs.existsSync(transcriptPath)) {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    exitProcess(1);
}

const state: {
    nextRequestId: number;
    lastUuid: string | null;
    interrupted: boolean;
    turnRunning: boolean;
    queued: Array<{ text: string; content: unknown }>;
} = { nextRequestId: 1, lastUuid: null, interrupted: false, turnRunning: false, queued: [] };
const COMMANDS = [
    {
        name: 'compact',
        description: 'Clear conversation history but keep a summary in context',
        argumentHint: '<optional custom summarization instructions>',
    },
    { name: 'review', description: 'Review a pull request', argumentHint: '' },
    { name: 'exit', description: 'Exit the REPL', argumentHint: '' },
];
const pendingControl = new Map<string, (response: Json) => void>();

function send(message: Json) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry: Json) {
    const uuid = crypto.randomUUID();
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
            parentUuid: state.lastUuid,
            isSidechain: false,
            sessionId,
            cwd: process.cwd(),
            uuid,
            timestamp: new Date().toISOString(),
            ...entry,
        })}\n`,
    );
    state.lastUuid = uuid;
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function frame(entry: Json): Json {
    return { parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId, ...entry };
}

function assistant(messageId: string, block: Json) {
    const message = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [block],
        stop_reason: null,
        usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 40 },
    };
    send(frame({ type: 'assistant', message }));
    record({ type: 'assistant', message });
}

async function didStreamFully(text: string, chunkDelayMs: number): Promise<boolean> {
    const messageId = `msg_${crypto.randomUUID()}`;
    send(
        frame({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: messageId } },
        }),
    );
    send(
        frame({
            type: 'stream_event',
            event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            },
        }),
    );
    let streamed = '';
    for (const word of text.split(/(?<= )/u)) {
        if (state.interrupted) break;
        streamed += word;
        send(
            frame({
                type: 'stream_event',
                event: {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: word },
                },
            }),
        );
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
    }
    assistant(messageId, { type: 'text', text: streamed });
    return !state.interrupted;
}

function controlRequest(request: Json): Promise<Json> {
    const requestId = `fake-${state.nextRequestId++}`;
    send({ type: 'control_request', request_id: requestId, request });
    return new Promise((resolve) => pendingControl.set(requestId, resolve));
}

async function wasToolAllowed(
    name: string,
    input: Json,
    run: (input: Json) => { content: string; structured?: Json },
): Promise<boolean> {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    assistant(`msg_${crypto.randomUUID()}`, { type: 'tool_use', id: toolUseId, name, input });
    const decision = await controlRequest({
        subtype: 'can_use_tool',
        tool_name: name,
        input,
        tool_use_id: toolUseId,
        permission_suggestions: [
            {
                type: 'addRules',
                rules: [{ toolName: name }],
                behavior: 'allow',
                destination: 'session',
            },
        ],
        decision_reason: `Fake ${name} approval`,
    });
    const isAllowed = decision.behavior === 'allow';
    const updatedInput = (decision.updatedInput as Json | undefined) ?? input;
    const result = isAllowed
        ? run(updatedInput)
        : { content: typeof decision.message === 'string' ? decision.message : 'Denied' };
    const block = {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result.content,
        ...(!isAllowed && { is_error: true }),
    };
    const message = { role: 'user', content: [block] };
    send(
        frame({
            type: 'user',
            message,
            ...(result.structured && { tool_use_result: result.structured }),
        }),
    );
    record({
        type: 'user',
        message,
        ...(result.structured && { toolUseResult: result.structured }),
    });
    if (decision.interrupt === true) state.interrupted = true;
    return isAllowed;
}

function result(startedAt: number, text: string, isError = false) {
    send(
        frame({
            type: 'result',
            subtype: isError ? 'error_during_execution' : 'success',
            is_error: isError,
            duration_ms: Date.now() - startedAt,
            duration_api_ms: 10,
            num_turns: 1,
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1200, output_tokens: 40 },
            modelUsage: { [MODEL]: { contextWindow: 200_000 } },
            permission_denials: [],
            queued_turn_count: state.queued.length,
            ...(isError ? { errors: [text] } : { result: text }),
        }),
    );
    record({ type: 'system', subtype: 'turn_duration', durationMs: Date.now() - startedAt });
}

async function runTurn(text: string, content: unknown) {
    const startedAt = Date.now();
    state.interrupted = false;
    record({ type: 'user', message: { role: 'user', content: content ?? text } });
    send(
        frame({
            type: 'system',
            subtype: 'init',
            cwd: process.cwd(),
            model: MODEL,
            tools: [],
            permissionMode: 'default',
            slash_commands: COMMANDS.map((command) => command.name),
            terminal_slash_commands: ['exit'],
        }),
    );
    if (text.trim() === '/compact') {
        send(frame({ type: 'system', subtype: 'compact_boundary' }));
        record({ type: 'system', subtype: 'compact_boundary' });
        result(startedAt, 'Compacted.');
        return;
    }
    const imageCount = Array.isArray(content)
        ? content.filter((block) => (block as { type?: unknown }).type === 'image').length
        : 0;
    if (imageCount > 0) {
        await didStreamFully(`Received ${imageCount} image${imageCount === 1 ? '' : 's'}.`, 0);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('crash')) exitProcess(1);
    if (text.includes('fail')) {
        result(startedAt, 'The fake model is overloaded.', true);
        return;
    }
    if (text.includes('approve')) {
        const isAllowed = await wasToolAllowed(
            'Bash',
            { command: 'echo approved', description: 'Print a confirmation' },
            () => ({ content: 'approved' }),
        );
        if (!isInterrupted())
            await didStreamFully(isAllowed ? 'The command ran.' : 'Skipped the command.', 0);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('edit')) {
        const filePath = path.join(process.cwd(), 'notes.txt');
        const isAllowed = await wasToolAllowed(
            'Edit',
            { file_path: filePath, old_string: 'old line', new_string: 'new line' },
            () => ({
                content: 'The file has been updated.',
                structured: {
                    filePath,
                    structuredPatch: [
                        {
                            oldStart: 3,
                            oldLines: 1,
                            newStart: 3,
                            newLines: 1,
                            lines: ['-old line', '+new line'],
                        },
                    ],
                },
            }),
        );
        if (!isInterrupted())
            await didStreamFully(isAllowed ? 'Edited notes.txt.' : 'Left notes.txt alone.', 0);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('planmode')) {
        const isAllowed = await wasToolAllowed(
            'ExitPlanMode',
            { plan: '1. Read the notes.\n2. Summarize them in one paragraph.' },
            () => ({ content: 'User has approved your plan.' }),
        );
        if (!isInterrupted())
            await didStreamFully(isAllowed ? 'Plan approved.' : 'Kept planning.', 0);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('ask')) {
        let answer = 'nothing';
        await wasToolAllowed(
            'AskUserQuestion',
            {
                questions: [
                    {
                        header: 'Color',
                        question: 'Which color?',
                        multiSelect: false,
                        options: [
                            { label: 'Blue', description: 'Calm' },
                            { label: 'Red', description: 'Bold' },
                        ],
                    },
                ],
            },
            (input) => {
                const answers = (input.answers as Record<string, string> | undefined) ?? {};
                answer = answers['Which color?'] ?? 'nothing';
                return { content: `User has answered your questions: "Which color?"="${answer}".` };
            },
        );
        if (!isInterrupted()) await didStreamFully(`You chose ${answer}.`, 0);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('table')) {
        await didStreamFully(
            [
                'Here are the options:',
                '',
                '| Option | Cost |',
                '| --- | --- |',
                '| Safe | Low |',
                '| Fast | High |',
                '',
                '```ts',
                'const choice = "Safe";',
                '```',
            ].join('\n'),
            0,
        );
        result(startedAt, 'done');
        return;
    }
    if (text.includes('pause')) {
        await didStreamFully('Thinking it over before answering.', 200);
        result(startedAt, 'done');
        return;
    }
    if (text.includes('slow')) {
        const isComplete = await didStreamFully(
            Array.from({ length: 400 }, (_, index) => `word${index} `).join(''),
            25,
        );
        result(startedAt, isComplete ? 'done' : 'interrupted', !isComplete);
        return;
    }
    const thinkingId = `msg_${crypto.randomUUID()}`;
    send(
        frame({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: thinkingId } },
        }),
    );
    send(
        frame({
            type: 'stream_event',
            event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
            },
        }),
    );
    send(
        frame({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Considering the request.' },
            },
        }),
    );
    assistant(thinkingId, {
        type: 'thinking',
        thinking: 'Considering the request.',
        signature: 'fake',
    });
    assistant(thinkingId, {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID()}`,
        name: 'TodoWrite',
        input: {
            todos: [
                { content: 'Read the message', status: 'completed', activeForm: 'Reading' },
                { content: 'Reply', status: 'in_progress', activeForm: 'Replying' },
            ],
        },
    });
    await didStreamFully(`Hello from fake Claude. You said: ${text}`, 5);
    result(startedAt, 'done');
}

async function drain() {
    if (state.turnRunning) return;
    state.turnRunning = true;
    while (state.queued.length > 0) {
        const next = state.queued.shift();
        // eslint-disable-next-line no-await-in-loop -- turns run one at a time, like the real CLI
        if (next) await runTurn(next.text, next.content);
    }
    state.turnRunning = false;
}

/**
 * Reads the flag through a call so TypeScript does not keep a narrowing across awaits that an interrupt can change.
 */
function isInterrupted(): boolean {
    return state.interrupted;
}

function userText(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const { content } = message as { content?: unknown };
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) =>
            block && typeof block === 'object' && 'text' in block
                ? String((block as { text: unknown }).text)
                : '',
        )
        .join('');
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as Json;
    if (message.type === 'control_response') {
        const response = message.response as Json;
        const requestId = String(response.request_id);
        const resolve = pendingControl.get(requestId);
        pendingControl.delete(requestId);
        resolve?.((response.response as Json | undefined) ?? {});
        return;
    }
    if (message.type === 'control_request') {
        const request = message.request as Json;
        if (request.subtype === 'interrupt') state.interrupted = true;
        send({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: message.request_id,
                response:
                    request.subtype === 'initialize'
                        ? {
                              commands: COMMANDS,
                              agents: [],
                              models: [
                                  { value: MODEL, displayName: 'Fake', description: 'Fake model' },
                              ],
                              account: {},
                              output_style: 'default',
                              available_output_styles: ['default'],
                          }
                        : {},
            },
        });
        return;
    }
    if (message.type === 'user') {
        state.queued.push({
            text: userText(message.message),
            content: (message.message as { content?: unknown } | undefined)?.content,
        });
        // eslint-disable-next-line no-void -- the turn loop reports through stdout
        void drain();
    }
});
lines.on('close', () => exitProcess(0));
