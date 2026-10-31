/**
 * Deterministic stand-in for `claude` driven by the Claude Agent SDK (`--input-format stream-json --output-format
 * stream-json --permission-prompt-tool=stdio`), used by Agent Chat unit tests and fake-mode E2E so no test ever
 * launches the real CLI or calls a model. Behavior is selected by keywords in the user's message:
 *
 * - `approve`: a Bash command needing approval; accept runs it, decline records it as declined.
 * - `edit`: a file edit needing approval; accept reports a structured patch.
 * - `ask`: an `AskUserQuestion` question; the reply quotes the chosen answer.
 * - `ask recommended`: two `AskUserQuestion` questions, each with a `(Recommended)` option.
 * - `ask multi`: one multi-select `AskUserQuestion` question; the reply lists the chosen options.
 * - `planmode`: an `ExitPlanMode` approval, the generic tool request kind that is neither a command nor a file edit.
 * - `slow`: a long streamed reply that an interrupt can stop.
 * - `pause`: a short reply streamed over about a second, long enough to send another message into the turn.
 * - `fail`: a failed turn with an error result.
 * - `crash`: the process exits mid-turn.
 * - `table`: a reply with a Markdown table and a fenced code block.
 * - `use chrome`: three Claude in Chrome (`mcp__claude-in-chrome__*`) browser steps, the last one failing, then a reply.
 * - `enter worktree <path>` / `exit worktree <path>`: `EnterWorktree` / `ExitWorktree` (`fake-claude-worktree.ts`).
 * - `subagent`: a foreground `Agent` subagent whose own frames carry `parent_tool_use_id`, with `task_*` frames and a
 *   subagent transcript (`subagents/agent-<id>.jsonl` plus `.meta.json`) beside the session transcript.
 * - `workflow`: a `Workflow` tool call whose `local_workflow` task runs until `stop_task`; `quick workflow` finishes it.
 * - `background agent`: a background subagent that keeps running until `stop_task`; `quick background agent` finishes it
 *   on its own and then wakes the main thread, which starts a turn without a user message.
 * - `quick background`: a background Bash command that finishes on its own and then wakes the main thread, which starts a
 *   turn without a user message.
 * - `background`: a background Bash command that prints a tick every 100 ms until `stop_task`.
 * - Anything else: thinking, a todo list, and a streamed reply quoting the message.
 *
 * Under `FAKE_CLAUDE_SCRIPT`, a JSON file of scripted turns (`fake-claude-script.ts`), a message equal to a turn's
 * prompt plays that turn and wins over every keyword above; the file's `model` renames the default model.
 *
 * A message with images is answered with how many it received. `/compact` compacts the conversation, reporting `status:
 * compacting` first; `/compact break` fails with a compaction error and `/compact crash` exits mid-compaction. The CLI
 * reports `/compact`, `/review`, the built-in `/goal` (`fake-claude-goal.ts`), and the terminal-bound `/exit` as its
 * commands. A message steered with `priority: 'next'` is quoted with `[next]`. It lists an `opus` alias and a model
 * without effort control; `set_model` and an `effortLevel` flag setting change what the next init message and hook
 * input report. Ultracode is a flag setting offered only on models with effort control, and an effort change without an
 * `ultracode` key turns it off. A `fastMode` flag setting turns Fast mode on, which `initialize`, the init message, and
 * the result report.
 *
 * A `side_question` control request is answered at once, even mid-turn, unless held (`fake-claude-side.ts`).
 *
 * Like the real CLI, `session_state_changed` is reported only under `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, subagent
 * text only when `initialize` asked for `forwardSubagentText`, and an interrupt kills background subagents unless
 * `initialize` declared `perTaskStopAffordance`. A background shell always survives an interrupt, with no task event.
 *
 * Every turn is appended to a JSONL transcript at Claude Code's own location under `CLAUDE_CONFIG_DIR`, so `--resume`
 * and Caxri's transcript-based history read real records.
 *
 * Under `FAKE_CLAUDE_CONTROL_DIR`, a file the test creates there turns on a failure the real CLI can produce: with
 * `drop-images`, the transcript keeps no image blocks, as when the record no longer has the original; with
 * `reject-model-change`, `set_model` answers with an error; with `plan-behind-pace`, `get_usage` reports a weekly limit
 * spent faster than an even pace; with `hold-reply`, a `think quietly` turn shows nothing until the file is removed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { didRunApprovalScenario } from './fake-claude-approvals.ts';
import { didRunCompactingTurn, runCompactCommand } from './fake-claude-compaction.ts';
import { didRunGoalCommand } from './fake-claude-goal.ts';
import type { FakeClaudeIo, FakeClaudeUsage, QueuedTurn } from './fake-claude-io.ts';
import { queuedTurn } from './fake-claude-io.ts';
import {
    FAKE_CLAUDE_COMMANDS,
    fakeClaudeFastMode,
    fakeClaudeModels,
    fakeClaudeSessionAnswer,
    hookCallbackIds,
    hookCallbackRequest,
    resolveFakeClaudeModel,
} from './fake-claude-models.ts';
import { didRunFakeClaudeOneShot } from './fake-claude-print.ts';
import {
    didStreamTable,
    streamBrowserSteps,
    streamPacedReply,
    streamPlannedReply,
} from './fake-claude-replies.ts';
import { resumedLeaf, rewindFiles } from './fake-claude-rewind.ts';
import { loadFakeClaudeScriptOrExit } from './fake-claude-script.ts';
import { answerSideQuestion, didHoldSideQuestion } from './fake-claude-side.ts';
import { didStartBackgroundTask, runSubagent, taskControl } from './fake-claude-tasks.ts';
import { didRunUsageLimitScenario } from './fake-claude-usage-limit.ts';
import { noteFakeClaudeWindowRequest } from './fake-claude-window.ts';
import { didRunWorktreeScenario } from './fake-claude-worktree.ts';

type Json = Record<string, unknown>;

// Meets the provider rename and low-cost generation minimum (2.1.232); `fake-claude-print.ts` answers both.
if (process.argv.includes('--version')) {
    process.stdout.write('2.1.232 (Claude Code)\n');
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
const controlDirectory = process.env.FAKE_CLAUDE_CONTROL_DIR;
const isControlled = (name: string) =>
    controlDirectory !== undefined && fs.existsSync(path.join(controlDirectory, name));
let transcriptPath = path.join(
    configDirectory,
    'projects',
    process.cwd().replaceAll(/[^a-z0-9]/giu, '-'),
    `${sessionId}.jsonl`,
);

if (resumeId && !fs.existsSync(transcriptPath)) {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    exitProcess(1);
}

if (await didRunFakeClaudeOneShot(configDirectory, sessionId, transcriptPath, controlDirectory))
    exitProcess(0);

const script = loadFakeClaudeScriptOrExit();
const { models, defaultModel } = fakeClaudeModels(script?.model);
const state: {
    nextRequestId: number;
    lastUuid: string | null;
    interrupted: boolean;
    turnRunning: boolean;
    queued: QueuedTurn[];
    model: string;
    effort?: string;
    ultracode: boolean;
    fastMode: boolean;
    /**
     * `--permission-mode`, then whatever `set_permission_mode` or an approved plan switched to.
     */
    permissionMode: string;
    /**
     * Whether the current turn's prompt asked for a large context. Real long conversations fill most of the compaction
     * window; this lets a dev instance or E2E show the high-context `/compact` warning without one.
     */
    isLargeContextTurn: boolean;
    /**
     * Callback ids the SDK registered per hook event in `initialize`.
     */
    hooks: Record<string, string[]>;
    /**
     * What a scripted response reported; it also sets the context `get_context_usage` reports.
     */
    usage?: FakeClaudeUsage;
} = {
    nextRequestId: 1,
    lastUuid: null,
    interrupted: false,
    turnRunning: false,
    queued: [],
    model: defaultModel,
    ultracode: false,
    fastMode: false,
    permissionMode: argument('--permission-mode') ?? 'default',
    isLargeContextTurn: false,
    hooks: {},
};
const isEmittingSessionState = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1';
const pendingControl = new Map<string, (response: Json) => void>();

state.lastUuid = resumeId ? resumedLeaf(transcriptPath, argument('--resume-session-at')) : null;

function send(message: Json) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Every mode this process switches to, in `permission-modes.jsonl` under `CLAUDE_CONFIG_DIR`, so a test can tell
 * whether it ever passed through a looser mode.
 */
function setPermissionMode(mode: string) {
    state.permissionMode = mode;
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.appendFileSync(
        path.join(configDirectory, 'permission-modes.jsonl'),
        `${JSON.stringify({ mode })}\n`,
    );
}

function record(entry: Json) {
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : crypto.randomUUID();
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
            parentUuid: state.lastUuid,
            isSidechain: false,
            // Stamped like the real CLI (`sdk-ts` when unset); Session search keys its hosted-conversation rule on it.
            entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? 'sdk-ts',
            sessionId,
            cwd: process.cwd(),
            uuid,
            timestamp: new Date().toISOString(),
            ...entry,
        })}\n`,
    );
    state.lastUuid = uuid;
}

function frame(entry: Json): Json {
    return { parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId, ...entry };
}

function system(subtype: string, fields: Json = {}) {
    send(frame({ type: 'system', subtype, ...fields }));
}

function sessionState(value: 'idle' | 'running') {
    if (isEmittingSessionState) system('session_state_changed', { state: value });
}

function turnUsage(): FakeClaudeUsage {
    const cached = state.isLargeContextTurn ? 140_000 : 800;
    return (
        state.usage ?? { input_tokens: 1200, cache_read_input_tokens: cached, output_tokens: 40 }
    );
}

function assistant(messageId: string, block: Json) {
    const message = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: defaultModel,
        content: [block],
        stop_reason: null,
        usage: turnUsage(),
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

async function fireHook(event: string, fields: Json) {
    const callbackIds = state.hooks[event] ?? [];
    for (const callbackId of callbackIds) {
        // eslint-disable-next-line no-await-in-loop -- the CLI awaits each hook before continuing
        await controlRequest(
            hookCallbackRequest(callbackId, event, { effort: state.effort, sessionId }, fields),
        );
    }
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
            usage: turnUsage(),
            modelUsage: { [defaultModel]: { contextWindow: 200_000 } },
            permission_denials: [],
            queued_turn_count: state.queued.length,
            ...fakeClaudeFastMode(state),
            ...(isError ? { errors: [text] } : { result: text }),
        }),
    );
    record({ type: 'system', subtype: 'turn_duration', durationMs: Date.now() - startedAt });
}

function toolResult(toolUseId: string, content: string) {
    const message = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    };
    send(frame({ type: 'user', message }));
    record({ type: 'user', message });
}

/**
 * What the scenario modules need from this process.
 */
const scenarioIo: FakeClaudeIo = {
    send,
    record,
    frame,
    system,
    assistant,
    toolResult,
    result: (startedAt, text, isError) => result(startedAt, text, isError),
    didStreamFully,
    controlRequest,
    fireHook,
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- EnterWorktree relocates the transcript
    transcript: (next) => (transcriptPath = next ?? transcriptPath),
    isInterrupted,
    markInterrupted: () => {
        state.interrupted = true;
    },
    setUsage: (usage) => {
        state.usage = usage;
    },
    exitPlanMode: (mode = 'default') => {
        if (state.permissionMode !== 'plan') return;
        setPermissionMode(mode);
        system('status', { status: null, permissionMode: state.permissionMode });
    },
    subagentDirectory: path.join(path.dirname(transcriptPath), sessionId, 'subagents'),
    startAutoTurn: () => {
        state.queued.push({ text: '', content: undefined, isAuto: true });
        void drain();
    },
};

async function runTurn({ text, content, priority, uuid, isAuto = false }: QueuedTurn) {
    const startedAt = Date.now();
    state.interrupted = false;
    if (!isAuto)
        record({
            type: 'user',
            ...(uuid && { uuid }),
            message: {
                role: 'user',
                content:
                    Array.isArray(content) && isControlled('drop-images')
                        ? content.filter((block) => (block as { type?: unknown }).type !== 'image')
                        : (content ?? text),
            },
        });
    send(
        frame({
            type: 'system',
            subtype: 'init',
            cwd: process.cwd(),
            model: state.model,
            tools: [],
            permissionMode: state.permissionMode,
            slash_commands: FAKE_CLAUDE_COMMANDS.map((command) => command.name),
            terminal_slash_commands: ['exit'],
            ...fakeClaudeFastMode(state),
        }),
    );
    if (isAuto) {
        await didStreamFully('The background command finished.', 0);
        result(startedAt, 'done');
        return;
    }
    await fireHook('UserPromptSubmit', { prompt: text });
    if (await script?.didRunTurn(scenarioIo, startedAt, text, isControlled)) return;
    state.usage = undefined;
    if (await didRunGoalCommand(scenarioIo, startedAt, text)) return;
    if (text.trimStart().startsWith('/compact')) {
        system('status', { status: 'compacting' });
        if (text.includes('crash')) exitProcess(1);
        await runCompactCommand(scenarioIo, startedAt, text);
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
    state.isLargeContextTurn = text.includes('large context');
    if (text.includes('crash')) exitProcess(1);
    if (text.includes('subagent')) {
        await runSubagent(scenarioIo, startedAt);
        return;
    }
    if (text.includes('continue on its own')) {
        await didStreamFully('Started the job in the background.', 0);
        result(startedAt, 'done');
        setTimeout(() => {
            void continueAfterBackgroundTask();
        }, 100);
        return;
    }
    if (didStartBackgroundTask(scenarioIo, startedAt, text)) return;
    if (await didRunUsageLimitScenario(scenarioIo, startedAt, text)) return;
    if (text.includes('fail')) {
        result(startedAt, 'The fake model is overloaded.', true);
        return;
    }
    if (await didRunApprovalScenario(scenarioIo, startedAt, text)) return;
    if (await didRunWorktreeScenario(scenarioIo, startedAt, text)) return;
    if (await didStreamTable(scenarioIo, startedAt, text)) return;
    if (await didRunCompactingTurn(scenarioIo, startedAt, text)) return;
    if (text.includes('use chrome')) {
        await streamBrowserSteps(scenarioIo);
        result(startedAt, 'done');
        return;
    }
    const paced = await streamPacedReply(scenarioIo, text, () => isControlled('hold-reply'));
    if (paced) {
        result(startedAt, paced.isComplete ? 'done' : 'interrupted', !paced.isComplete);
        return;
    }
    await streamPlannedReply(
        scenarioIo,
        `You said: ${text}${priority === 'next' ? ' [next]' : ''}`,
    );
    result(startedAt, 'done');
}

/**
 * What Claude Code does when a background task finishes after the turn that started it ended: it reports the task and
 * continues the conversation on its own, with no user message opening the turn.
 */
async function continueAfterBackgroundTask() {
    state.turnRunning = true;
    const startedAt = Date.now();
    const outputFile = path.join(process.cwd(), 'job.log');
    send(
        frame({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'fake-task',
            status: 'completed',
            output_file: outputFile,
            summary: 'Background job finished',
        }),
    );
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command: 'cat job.log', description: 'Read the job output' },
    });
    await delay(300);
    const message = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    };
    send(frame({ type: 'user', message }));
    record({ type: 'user', message });
    await didStreamFully('The background job finished.', 0);
    result(startedAt, 'done');
    state.turnRunning = false;
    await drain();
}

async function drain() {
    if (state.turnRunning || state.queued.length === 0) return;
    state.turnRunning = true;
    sessionState('running');
    while (state.queued.length > 0) {
        const next = state.queued.shift();
        // eslint-disable-next-line no-await-in-loop -- turns run one at a time, like the real CLI
        if (next) await runTurn(next);
    }
    state.turnRunning = false;
    sessionState('idle');
}

/**
 * Reads the flag through a call so TypeScript does not keep a narrowing across awaits that an interrupt can change.
 */
function isInterrupted(): boolean {
    return state.interrupted;
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
        if (didHoldSideQuestion(request, () => lines.emit('line', line))) return;
        if (request.subtype === 'set_model' && isControlled('reject-model-change')) {
            send({
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: message.request_id,
                    error: 'Model switch rejected',
                },
            });
            return;
        }
        if (request.subtype === 'interrupt') state.interrupted = true;
        else if (request.subtype === 'initialize') state.hooks = hookCallbackIds(request.hooks);
        if (request.subtype === 'set_model' && typeof request.model === 'string')
            state.model = resolveFakeClaudeModel(models, request.model);
        const flags = request.subtype === 'apply_flag_settings' ? (request.settings as Json) : {};
        if (typeof flags.effortLevel === 'string') {
            // Like the real CLI, moving the effort without an `ultracode` key turns ultracode off.
            if (flags.effortLevel !== state.effort && !('ultracode' in flags))
                state.ultracode = false;
            state.effort = flags.effortLevel;
        }
        if (typeof flags.ultracode === 'boolean') state.ultracode = flags.ultracode;
        if (typeof flags.fastMode === 'boolean') state.fastMode = flags.fastMode;
        if (request.subtype === 'set_permission_mode' && typeof request.mode === 'string')
            setPermissionMode(request.mode);
        const answer =
            request.subtype === 'rewind_files'
                ? rewindFiles(request, transcriptPath, configDirectory)
                : request.subtype === 'side_question'
                  ? answerSideQuestion(request, configDirectory)
                  : taskControl(scenarioIo, request);
        if (answer.error !== undefined) {
            send({
                type: 'control_response',
                response: { subtype: 'error', request_id: message.request_id, error: answer.error },
            });
            return;
        }
        send({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: message.request_id,
                response:
                    fakeClaudeSessionAnswer(request.subtype, { ...state, models }) ??
                    answer.response ??
                    {},
            },
        });
        return;
    }
    if (message.type === 'user') {
        noteFakeClaudeWindowRequest();
        state.queued.push(queuedTurn(message));
        void drain();
    }
});
lines.on('close', () => exitProcess(0));
