/**
 * Scripted turns for the fake Claude Code CLI (`fake-claude-cli.ts`). Its keyword scenarios give canned replies; a
 * promotional screenshot or a demo needs a believable, repeatable conversation instead. `FAKE_CLAUDE_SCRIPT` names a
 * JSON file ({@link FakeClaudeScript}) whose turns the CLI plays when the user's message equals a turn's prompt, with
 * the same frames, approvals, and transcript records the keyword scenarios produce, so the Chat, history, resume, Fork,
 * and the mobile Conversation read them like any other turn. A message that matches no turn keeps the keyword
 * behavior.
 *
 * A malformed file stops the CLI at startup (`loadFakeClaudeScriptOrExit`), so a demo never falls back to canned
 * replies without saying so.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { sendToolResult, wasToolAllowed } from './fake-claude-approvals.ts';
import type { FakeClaudeIo, FakeClaudeUsage } from './fake-claude-io.ts';
import { fileToolResult } from './fake-claude-script-patch.ts';

type Json = Record<string, unknown>;

/**
 * The JSON file `FAKE_CLAUDE_SCRIPT` names.
 */
export interface FakeClaudeScript {
    /**
     * Replaces the default model's value and display name everywhere the fake reports it (initialize model list, init
     * message, assistant messages, result `modelUsage`), e.g. `{ value: 'claude-opus-4-7', displayName: 'Opus 4.7' }`.
     * The default fake model has no price, so a check that expects a nonzero estimated cost names a model the bundled
     * price list (`bundled-prices.generated.json`) carries.
     */
    model?: { value: string; displayName: string };
    turns: FakeClaudeScriptTurn[];
}

export interface FakeClaudeScriptTurn {
    /**
     * The user message that starts this turn, compared after trimming. Prompts are unique within a script.
     */
    prompt: string;
    steps: FakeClaudeScriptStep[];
}

/**
 * One step of a scripted turn. Every string in it may contain `{{cwd}}`, replaced by the Session's working directory:
 * Claude Code reports absolute paths, so a file tool's `file_path` is `{{cwd}}/src/file.ts`.
 */
export type FakeClaudeScriptStep =
    | { kind: 'thinking'; text: string }
    | {
          kind: 'todos';
          todos: Array<{
              content: string;
              status: 'pending' | 'in_progress' | 'completed';
              activeForm: string;
          }>;
      }
    /**
     * A tool call that already ran (Read, Grep, Glob, Bash, Edit, Write, ...). `Edit` and `Write` report the structured
     * patch the `edit` scenario reports after approval, so the Chat shows a diff: with line numbers and context when
     * the file named by `file_path` exists, else from the input text alone. A failed `Bash` call starts its `output`
     * with `Exit code N`, as Claude Code's does. The fake never changes a file; seed the Project with the edit applied
     * to make its Git panel agree with the Chat.
     */
    | {
          kind: 'tool';
          name: string;
          input: Record<string, unknown>;
          output: string;
          isError?: boolean;
          /**
           * How long the call seems to run before its result arrives (default 250 ms), shown as the tool row's
           * duration.
           */
          durationMs?: number;
      }
    /**
     * A tool call that asks for approval through `can_use_tool`, like the `approve` scenario, and waits for the answer;
     * the Session shows as waiting. Accept runs it with `output`; decline records it as declined, and the turn ends
     * with a short reply instead of playing the steps after it.
     */
    | { kind: 'approval'; name: string; input: Record<string, unknown>; output: string }
    /**
     * Streamed assistant text (Markdown allowed).
     */
    | { kind: 'text'; text: string; chunkDelayMs?: number }
    /**
     * Keeps the turn running (no output) while `<FAKE_CLAUDE_CONTROL_DIR>/<file>` exists, then continues.
     */
    | { kind: 'hold'; file: string }
    /**
     * Ends the turn as failed with this error text. It must be a turn's last step.
     */
    | { kind: 'fail'; message: string };

const STEP_FIELDS = {
    thinking: ['text'],
    todos: ['todos'],
    tool: ['name', 'input', 'output', 'isError', 'durationMs'],
    approval: ['name', 'input', 'output'],
    text: ['text', 'chunkDelayMs'],
    hold: ['file'],
    fail: ['message'],
} as const;

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(at: string, problem: string): never {
    throw new Error(`${at}: ${problem}`);
}

function checkFields(at: string, value: Json, allowed: readonly string[]) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            fail(at, `unknown field "${key}" (expected ${allowed.join(', ')})`);
}

function requireText(at: string, value: Json, field: string): string {
    const found = value[field];
    if (typeof found !== 'string' || found.trim() === '')
        return fail(`${at}.${field}`, 'expected a non-empty string');
    return found;
}

function requireOutput(at: string, value: Json): string {
    if (typeof value.output !== 'string') return fail(`${at}.output`, 'expected a string');
    return value.output;
}

function requireDuration(at: string, value: Json, field: string) {
    const found = value[field];
    if (found !== undefined && (typeof found !== 'number' || !Number.isFinite(found) || found < 0))
        fail(`${at}.${field}`, 'expected a number of milliseconds, zero or more');
}

function requireInput(at: string, value: Json) {
    if (!isRecord(value.input)) fail(`${at}.input`, 'expected an object');
}

function checkTodos(at: string, value: Json): void {
    if (!Array.isArray(value.todos) || value.todos.length === 0)
        fail(`${at}.todos`, 'expected a non-empty array');
    for (const [index, todo] of (value.todos as unknown[]).entries()) {
        const todoAt = `${at}.todos[${index}]`;
        if (!isRecord(todo)) return fail(todoAt, 'expected an object');
        checkFields(todoAt, todo, ['content', 'status', 'activeForm']);
        requireText(todoAt, todo, 'content');
        requireText(todoAt, todo, 'activeForm');
        if (typeof todo.status !== 'string' || !TODO_STATUSES.has(todo.status))
            fail(`${todoAt}.status`, 'expected pending, in_progress, or completed');
    }
}

function checkStep(at: string, value: unknown): FakeClaudeScriptStep {
    if (!isRecord(value)) return fail(at, 'expected an object');
    const kind = value.kind as keyof typeof STEP_FIELDS;
    if (typeof kind !== 'string' || !Object.hasOwn(STEP_FIELDS, kind))
        return fail(`${at}.kind`, `expected one of ${Object.keys(STEP_FIELDS).join(', ')}`);
    checkFields(at, value, ['kind', ...STEP_FIELDS[kind]]);
    switch (kind) {
        case 'thinking':
        case 'text': {
            requireText(at, value, 'text');
            requireDuration(at, value, 'chunkDelayMs');
            break;
        }
        case 'todos': {
            checkTodos(at, value);
            break;
        }
        case 'tool':
        case 'approval': {
            requireText(at, value, 'name');
            requireInput(at, value);
            requireOutput(at, value);
            requireDuration(at, value, 'durationMs');
            if (value.isError !== undefined && typeof value.isError !== 'boolean')
                fail(`${at}.isError`, 'expected a boolean');
            break;
        }
        case 'hold': {
            // A bare file name, so a script cannot reach outside FAKE_CLAUDE_CONTROL_DIR.
            if (requireText(at, value, 'file') !== path.basename(value.file as string))
                fail(`${at}.file`, 'expected a file name without a directory');
            break;
        }
        case 'fail': {
            requireText(at, value, 'message');
            break;
        }
    }
    return value as FakeClaudeScriptStep;
}

function checkTurn(at: string, value: unknown): FakeClaudeScriptTurn {
    if (!isRecord(value)) return fail(at, 'expected an object');
    checkFields(at, value, ['prompt', 'steps']);
    const prompt = requireText(at, value, 'prompt').trim();
    if (!Array.isArray(value.steps) || value.steps.length === 0)
        return fail(`${at}.steps`, 'expected a non-empty array');
    const steps = (value.steps as unknown[]).map((step, index) =>
        checkStep(`${at}.steps[${index}]`, step),
    );
    const failIndex = steps.findIndex((step) => step.kind === 'fail');
    if (failIndex !== -1 && failIndex !== steps.length - 1)
        fail(`${at}.steps[${failIndex}]`, 'a fail step must be the last step of its turn');
    return { prompt, steps };
}

/**
 * Validates a parsed script and returns it with every prompt trimmed, naming the first problem by its path, e.g.
 * `turns[1].steps[0].kind: expected one of ...`.
 */
export function parseFakeClaudeScript(value: unknown): FakeClaudeScript {
    if (!isRecord(value)) return fail('script', 'expected an object');
    checkFields('script', value, ['model', 'turns']);
    let model: FakeClaudeScript['model'];
    if (value.model !== undefined) {
        if (!isRecord(value.model)) return fail('model', 'expected an object');
        checkFields('model', value.model, ['value', 'displayName']);
        model = {
            value: requireText('model', value.model, 'value'),
            displayName: requireText('model', value.model, 'displayName'),
        };
    }
    if (!Array.isArray(value.turns) || value.turns.length === 0)
        return fail('turns', 'expected a non-empty array');
    const turns = (value.turns as unknown[]).map((turn, index) =>
        checkTurn(`turns[${index}]`, turn),
    );
    const seen = new Set<string>();
    for (const [index, turn] of turns.entries()) {
        if (seen.has(turn.prompt))
            fail(`turns[${index}].prompt`, `"${turn.prompt}" repeats an earlier prompt`);
        seen.add(turn.prompt);
    }
    return { ...(model && { model }), turns };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The simulated run time of a `tool` step that sets no `durationMs`.
 */
const DEFAULT_TOOL_DURATION_MS = 250;

/**
 * Chunk delay of a `text` step that sets none: a reply that visibly streams without stalling a demo.
 */
const DEFAULT_CHUNK_DELAY_MS = 12;

/**
 * What a session holds before its first message: Claude Code's system prompt and tool definitions.
 */
const BASE_CONTEXT_TOKENS = 24_000;

const DECLINED_REPLY = 'Understood, I skipped that step.';

const TODO_RESULT =
    'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';

/**
 * A rough token count, four characters to a token.
 */
const tokens = (characters: number) => Math.max(1, Math.ceil(characters / 4));

/**
 * The usage of the conversation's model requests: each reads the whole context so far from the cache, writes what is
 * new since the last request (the user's message or a tool result), and adds its own reply, so the context grows the
 * way a real conversation's does. The meter lives in the CLI process, so a resumed Chat starts again from the base.
 */
class ContextMeter {
    private context = BASE_CONTEXT_TOKENS;

    private unread = 0;

    /**
     * Text the model has not read yet.
     */
    feed(characters: number) {
        this.unread += tokens(characters);
    }

    /**
     * One model request that writes `characters` of reply.
     */
    respond(characters: number): FakeClaudeUsage {
        const usage = {
            input_tokens: 6,
            cache_creation_input_tokens: this.unread,
            cache_read_input_tokens: this.context,
            output_tokens: tokens(characters),
        };
        this.context +=
            usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens;
        this.unread = 0;
        return usage;
    }
}

/**
 * Replaces `{{cwd}}` in every string of a step with the Session's working directory. That is the resolved path, so a
 * Project under a symlink (macOS `/tmp` or `/var`) should be created at its real path for file rows to match it.
 */
function fillCwd<T>(value: T): T {
    if (typeof value === 'string') return value.replaceAll('{{cwd}}', () => process.cwd()) as T;
    if (Array.isArray(value)) return value.map((item: unknown) => fillCwd(item)) as T;
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fillCwd(item)]),
    ) as T;
}

/**
 * What a finished tool call reports. `Bash` carries Claude Code's `stdout` result; `Edit` and `Write` carry their
 * patch.
 */
function toolOutcome(name: string, input: Json, output: string, isError = false) {
    if (isError) return { content: output, isError };
    const structured =
        name === 'Bash'
            ? { stdout: output, stderr: '', interrupted: false, isImage: false }
            : fileToolResult(name, input);
    return { content: output, ...(structured && { structured }) };
}

/**
 * Plays a script's turns for the CLI process that loaded it.
 */
export class FakeClaudeScriptPlayer {
    private readonly turns = new Map<string, FakeClaudeScriptTurn>();

    private readonly meter = new ContextMeter();

    /**
     * The task list the last `todos` step wrote, which the next one reports replacing.
     */
    private todos: unknown[] = [];

    /**
     * The script's model override, which the CLI lists and reports in place of its default model.
     */
    readonly model: FakeClaudeScript['model'];

    constructor(script: FakeClaudeScript) {
        this.model = script.model;
        for (const turn of script.turns) this.turns.set(turn.prompt, turn);
    }

    private respond(io: FakeClaudeIo, characters: number) {
        io.setUsage(this.meter.respond(characters));
    }

    private streamThinking(io: FakeClaudeIo, thinking: string) {
        const id = `msg_${crypto.randomUUID()}`;
        const stream = (event: Json) => io.send(io.frame({ type: 'stream_event', event }));
        this.respond(io, thinking.length);
        stream({ type: 'message_start', message: { id } });
        stream({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
        });
        stream({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking },
        });
        io.assistant(id, { type: 'thinking', thinking, signature: 'fake' });
    }

    private async runTool(io: FakeClaudeIo, step: Extract<FakeClaudeScriptStep, { kind: 'tool' }>) {
        const id = `toolu_${crypto.randomUUID()}`;
        const { input } = step;
        this.respond(io, JSON.stringify(input).length);
        io.assistant(`msg_${crypto.randomUUID()}`, {
            type: 'tool_use',
            id,
            name: step.name,
            input,
        });
        await delay(step.durationMs ?? DEFAULT_TOOL_DURATION_MS);
        sendToolResult(io, id, toolOutcome(step.name, input, step.output, step.isError));
        this.meter.feed(step.output.length);
    }

    private writeTodos(io: FakeClaudeIo, todos: unknown[]) {
        const id = `toolu_${crypto.randomUUID()}`;
        this.respond(io, JSON.stringify(todos).length);
        io.assistant(`msg_${crypto.randomUUID()}`, {
            type: 'tool_use',
            id,
            name: 'TodoWrite',
            input: { todos },
        });
        sendToolResult(io, id, {
            content: TODO_RESULT,
            structured: { oldTodos: this.todos, newTodos: todos },
        });
        this.todos = todos;
        this.meter.feed(TODO_RESULT.length);
    }

    /**
     * Returns whether an approval step was declined, which ends the turn.
     */
    private async play(
        io: FakeClaudeIo,
        step: Exclude<FakeClaudeScriptStep, { kind: 'fail' }>,
        isHeld: (file: string) => boolean,
    ): Promise<boolean> {
        switch (step.kind) {
            case 'thinking': {
                this.streamThinking(io, step.text);
                return false;
            }
            case 'todos': {
                this.writeTodos(io, step.todos);
                return false;
            }
            case 'tool': {
                await this.runTool(io, step);
                return false;
            }
            case 'approval': {
                this.respond(io, JSON.stringify(step.input).length);
                const isAllowed = await wasToolAllowed(
                    io,
                    step.name,
                    step.input,
                    (answered) => toolOutcome(step.name, answered, step.output),
                    undefined,
                    null,
                );
                if (isAllowed) this.meter.feed(step.output.length);
                return !isAllowed;
            }
            case 'text': {
                this.respond(io, step.text.length);
                await io.didStreamFully(step.text, step.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS);
                return false;
            }
            case 'hold': {
                // eslint-disable-next-line no-await-in-loop -- polls until the file is removed
                while (isHeld(step.file) && !io.isInterrupted()) await delay(100);
                return false;
            }
        }
    }

    /**
     * Plays the turn whose prompt equals `text`, ending it with a `result` (an error for a `fail` step or an
     * interrupt). Returns whether there was one; `isHeld` tells whether a `hold` step's control file exists.
     */
    async didRunTurn(
        io: FakeClaudeIo,
        startedAt: number,
        text: string,
        isHeld: (file: string) => boolean,
    ): Promise<boolean> {
        const turn = this.turns.get(text.trim());
        if (!turn) return false;
        this.meter.feed(text.length);
        let reply = 'done';
        for (const planned of turn.steps) {
            if (io.isInterrupted()) break;
            const step = fillCwd(planned);
            if (step.kind === 'fail') {
                io.result(startedAt, step.message, true);
                return true;
            }
            // eslint-disable-next-line no-await-in-loop -- steps play one at a time, in order
            const isDeclined = await this.play(io, step, isHeld);
            if (isDeclined) {
                if (!io.isInterrupted()) {
                    reply = DECLINED_REPLY;
                    this.respond(io, reply.length);
                    // eslint-disable-next-line no-await-in-loop -- the turn ends here
                    await io.didStreamFully(reply, 0);
                }
                break;
            }
            if (step.kind === 'text') reply = step.text;
        }
        if (io.isInterrupted()) io.result(startedAt, 'interrupted', true);
        else io.result(startedAt, reply);
        return true;
    }
}

/**
 * The player for the script `FAKE_CLAUDE_SCRIPT` names, or `undefined` when it names none. An unreadable or malformed
 * file ends the process with exit code 1 and the problem on stderr: this file stands in for a CLI process, and a demo
 * must not quietly fall back to canned replies.
 */
export function loadFakeClaudeScriptOrExit(
    scriptPath = process.env.FAKE_CLAUDE_SCRIPT,
): FakeClaudeScriptPlayer | undefined {
    if (!scriptPath) return undefined;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        return new FakeClaudeScriptPlayer(parseFakeClaudeScript(parsed));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`fake claude: invalid FAKE_CLAUDE_SCRIPT ${scriptPath}: ${reason}\n`);
        // eslint-disable-next-line unicorn/no-process-exit -- this file stands in for a CLI process, so exiting is part of its contract
        process.exit(1);
    }
}
