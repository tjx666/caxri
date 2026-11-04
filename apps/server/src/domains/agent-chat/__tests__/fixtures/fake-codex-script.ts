/**
 * Scripted turns for the fake Codex app-server (`fake-codex-app-server.ts`). The canned replies are fine for tests but
 * read as obviously fake in a promotional capture, so `FAKE_CODEX_SCRIPT` names a JSON file ({@link FakeCodexScript})
 * that gives chosen prompts believable turns: reasoning, a plan, finished commands, file changes, an approval, and a
 * streamed reply, with the default model renamed. A message whose trimmed text equals a scripted turn's prompt plays
 * that turn; every other message keeps the keyword scenarios. The script is validated once at startup and the process
 * exits with 1 and a stderr message when it is malformed, so a capture run never falls back to canned replies
 * silently.
 *
 * Playback goes through the same {@link FakeCodexIo} seam as the other scenarios, so scripted turns persist in the
 * thread state like any other and a resumed Chat reads them back. This file is loaded by Node's type stripping, so it
 * uses only erasable TypeScript syntax and `.ts` import specifiers.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';
import { playCommandApproval, playFileApproval } from './fake-codex-script-approval.ts';
import {
    asArray,
    asOneOf,
    asOptionalBoolean,
    asOptionalNumber,
    asRecord,
    asString,
    reject,
} from './fake-codex-script-validation.ts';

/**
 * The model the fake reports instead of `Fake Codex` wherever it names its default model.
 */
interface FakeCodexScriptModel {
    id: string;
    displayName: string;
}

type FakeCodexScriptPlanStatus = 'pending' | 'inProgress' | 'completed';
type FakeCodexScriptChangeKind = 'add' | 'update' | 'delete';

/**
 * One step of a scripted turn. Every string may contain `{{cwd}}`, which is replaced by the thread's working directory
 * (the Project root the Chat runs in); a relative file change path is resolved against it.
 */
type FakeCodexScriptStep =
    | { kind: 'reasoning'; summary: string[] }
    | {
          kind: 'plan';
          plan: Array<{ step: string; status: FakeCodexScriptPlanStatus }>;
      }
    /**
     * A finished command execution item, shaped like the `testrun` scenario's commands. `durationMs` is the time the
     * Chat shows for it (1200 when omitted); a non-zero exit code makes the item `failed`.
     */
    | {
          kind: 'command';
          command: string;
          output: string;
          exitCode?: number;
          durationMs?: number;
          /**
           * Actually runs `command` in a shell with the fake's own environment (which carries the Chat's managed Agent
           * endpoint, so the Caxri CLI acts as this Chat). The item then reports the real output and exit code instead
           * of `output` and `exitCode`.
           */
          shouldRun?: boolean;
      }
    /**
     * A finished file change item without approval, shaped like the `patch` and `artifacts` scenarios' file changes.
     * Nothing is written to disk, so a Project that should already hold the change is seeded that way.
     */
    | {
          kind: 'fileChange';
          changes: Array<{ path: string; kind: FakeCodexScriptChangeKind; diff: string }>;
      }
    /**
     * A command that asks for approval like the `approve` scenario and waits. Accept runs it with `output`; decline
     * records it as declined, the Agent says so, and the rest of the turn is skipped, as the Agent would stop there.
     * With `paths` (resolved against the Chat's working directory) it is a file change that updates those files
     * instead, and `command` and `output` are unused.
     */
    | { kind: 'approval'; command: string; output: string; paths?: string[] }
    /**
     * A streamed agent message (Markdown allowed).
     */
    | { kind: 'message'; text: string }
    /**
     * Keeps the turn in progress while `<FAKE_CODEX_CONTROL_DIR>/<file>` exists, then continues.
     */
    | { kind: 'hold'; file: string }
    /**
     * Ends the turn as failed with this provider error.
     */
    | { kind: 'fail'; message: string };

export interface FakeCodexScriptTurn {
    /**
     * The user message that starts this turn, compared after trimming. The first turn with a matching prompt plays.
     */
    prompt: string;
    /**
     * With `true`, the turn plays for any message that starts with `prompt` (trimmed), for a message whose tail is not
     * known when the script is written, such as a delegation pointer that ends in a generated ID.
     */
    isPrefix?: boolean;
    steps: FakeCodexScriptStep[];
    /**
     * What the turn reports as its duration (the `Worked for` caption), instead of the real playback time, which is a
     * few milliseconds.
     */
    durationMs?: number;
}

/**
 * The JSON file named by `FAKE_CODEX_SCRIPT`.
 */
export interface FakeCodexScript {
    /**
     * Replaces the default model's id and display name in `model/list` and in `thread/start` and `thread/resume`.
     */
    model?: FakeCodexScriptModel;
    turns: FakeCodexScriptTurn[];
}

const STEP_KINDS = [
    'reasoning',
    'plan',
    'command',
    'fileChange',
    'approval',
    'message',
    'hold',
    'fail',
] as const;
/**
 * Every field any step kind takes, for the first look at a step before its kind decides which apply.
 */
const STEP_FIELDS = [
    'kind',
    'summary',
    'plan',
    'command',
    'output',
    'exitCode',
    'durationMs',
    'shouldRun',
    'paths',
    'changes',
    'text',
    'file',
    'message',
] as const;
const PLAN_STATUSES = ['pending', 'inProgress', 'completed'] as const;
const CHANGE_KINDS = ['add', 'update', 'delete'] as const;

function parseStep(value: unknown, where: string, controlDirectory: string | undefined) {
    const kind = asOneOf(asRecord(value, where, STEP_FIELDS).kind, `${where}.kind`, STEP_KINDS);
    const fields = (...allowed: string[]) => asRecord(value, where, ['kind', ...allowed]);
    switch (kind) {
        case 'reasoning': {
            const summary = asArray(fields('summary').summary, `${where}.summary`);
            return {
                kind,
                summary: summary.map((part, index) => asString(part, `${where}.summary[${index}]`)),
            } satisfies FakeCodexScriptStep;
        }
        case 'plan': {
            const plan = asArray(fields('plan').plan, `${where}.plan`);
            return {
                kind,
                plan: plan.map((entry, index) => {
                    const at = `${where}.plan[${index}]`;
                    const record = asRecord(entry, at, ['step', 'status']);
                    return {
                        step: asString(record.step, `${at}.step`),
                        status: asOneOf(record.status, `${at}.status`, PLAN_STATUSES),
                    };
                }),
            } satisfies FakeCodexScriptStep;
        }
        case 'command': {
            const record = fields('command', 'output', 'exitCode', 'durationMs', 'shouldRun');
            const shouldRun = asOptionalBoolean(record.shouldRun, `${where}.shouldRun`);
            const exitCode = asOptionalNumber(record.exitCode, `${where}.exitCode`, true);
            const durationMs = asOptionalNumber(record.durationMs, `${where}.durationMs`, false);
            return {
                kind,
                command: asString(record.command, `${where}.command`),
                output: asString(record.output, `${where}.output`, true),
                ...(exitCode !== undefined && { exitCode }),
                ...(durationMs !== undefined && { durationMs }),
                ...(shouldRun && { shouldRun }),
            } satisfies FakeCodexScriptStep;
        }
        case 'fileChange': {
            const changes = asArray(fields('changes').changes, `${where}.changes`);
            return {
                kind,
                changes: changes.map((entry, index) => {
                    const at = `${where}.changes[${index}]`;
                    const record = asRecord(entry, at, ['path', 'kind', 'diff']);
                    return {
                        path: asString(record.path, `${at}.path`),
                        kind: asOneOf(record.kind, `${at}.kind`, CHANGE_KINDS),
                        diff: asString(record.diff, `${at}.diff`, true),
                    };
                }),
            } satisfies FakeCodexScriptStep;
        }
        case 'approval': {
            const record = fields('command', 'output', 'paths');
            const paths =
                record.paths === undefined
                    ? undefined
                    : asArray(record.paths, `${where}.paths`).map((entry, index) =>
                          asString(entry, `${where}.paths[${index}]`),
                      );
            return {
                kind,
                command: asString(record.command, `${where}.command`, paths !== undefined),
                output: asString(record.output, `${where}.output`, true),
                ...(paths && { paths }),
            } satisfies FakeCodexScriptStep;
        }
        case 'message': {
            return {
                kind,
                text: asString(fields('text').text, `${where}.text`),
            } satisfies FakeCodexScriptStep;
        }
        case 'hold': {
            const file = asString(fields('file').file, `${where}.file`);
            if (path.basename(file) !== file)
                reject(`${where}.file`, 'expected a plain file name without a directory');
            if (!controlDirectory)
                reject(where, 'a hold step needs FAKE_CODEX_CONTROL_DIR, which is not set');
            return { kind, file } satisfies FakeCodexScriptStep;
        }
        case 'fail': {
            return {
                kind,
                message: asString(fields('message').message, `${where}.message`),
            } satisfies FakeCodexScriptStep;
        }
    }
}

/**
 * Validates a parsed script and returns it, throwing an `Error` that names the offending field. `controlDirectory` is
 * `FAKE_CODEX_CONTROL_DIR`, which a `hold` step needs.
 */
export function parseFakeCodexScript(value: unknown, controlDirectory?: string): FakeCodexScript {
    const script = asRecord(value, 'script', ['model', 'turns']);
    let model: FakeCodexScriptModel | undefined;
    if (script.model !== undefined) {
        const record = asRecord(script.model, 'script.model', ['id', 'displayName']);
        model = {
            id: asString(record.id, 'script.model.id'),
            displayName: asString(record.displayName, 'script.model.displayName'),
        };
    }
    const turns = asArray(script.turns, 'script.turns').map((entry, index) => {
        const where = `script.turns[${index}]`;
        const record = asRecord(entry, where, ['prompt', 'steps', 'durationMs', 'isPrefix']);
        const durationMs = asOptionalNumber(record.durationMs, `${where}.durationMs`, false);
        const isPrefix = asOptionalBoolean(record.isPrefix, `${where}.isPrefix`);
        return {
            prompt: asString(record.prompt, `${where}.prompt`),
            ...(isPrefix && { isPrefix }),
            steps: asArray(record.steps, `${where}.steps`).map((step, stepIndex) =>
                parseStep(step, `${where}.steps[${stepIndex}]`, controlDirectory),
            ),
            ...(durationMs !== undefined && { durationMs }),
        };
    });
    // Same rules as the fake Claude script, so a scene reads the same way for both Agents.
    const prompts = new Set<string>();
    turns.forEach((turn, index) => {
        const failIndex = turn.steps.findIndex((step) => step.kind === 'fail');
        if (failIndex !== -1 && failIndex !== turn.steps.length - 1)
            reject(
                `script.turns[${index}].steps[${failIndex}]`,
                'a fail step must be the last step of its turn',
            );
        const prompt = turn.prompt.trim();
        if (prompts.has(prompt))
            reject(`script.turns[${index}].prompt`, `"${prompt}" repeats an earlier prompt`);
        prompts.add(prompt);
    });
    return { ...(model && { model }), turns };
}

const loaded: { isLoaded: boolean; script?: FakeCodexScript } = { isLoaded: false };

/**
 * The script `FAKE_CODEX_SCRIPT` names, or `undefined` without one. Read once; a missing or malformed file ends the
 * process with exit code 1 and the reason on stderr, since this file stands in for a CLI process whose contract it is
 * to fail at startup.
 */
export function fakeCodexScript(): FakeCodexScript | undefined {
    if (loaded.isLoaded) return loaded.script;
    loaded.isLoaded = true;
    const file = process.env.FAKE_CODEX_SCRIPT;
    if (!file) return undefined;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        loaded.script = parseFakeCodexScript(parsed, process.env.FAKE_CODEX_CONTROL_DIR);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`fake codex: invalid FAKE_CODEX_SCRIPT ${file}: ${reason}\n`);
        // eslint-disable-next-line unicorn/no-process-exit -- a stand-in CLI reports a bad script by exiting at startup
        process.exit(1);
    }
    return loaded.script;
}

/**
 * The scripted turn whose prompt equals the message, both trimmed, or starts it for a prefix turn.
 */
export function findScriptedTurn(
    script: FakeCodexScript | undefined,
    said: string,
): FakeCodexScriptTurn | undefined {
    const message = said.trim();
    return script?.turns.find((turn) =>
        turn.isPrefix ? message.startsWith(turn.prompt.trim()) : turn.prompt.trim() === message,
    );
}

/**
 * How often a `hold` step looks for its file.
 */
const HOLD_POLL_MS = 50;

/**
 * The context window the reported usage is measured against.
 */
const CONTEXT_WINDOW = 272_000;

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Codex reports a command as the login-shell invocation that ran it, with the script's quotes escaped the way
 * `unwrapShellCommand` reads them back.
 */
function shellInvocation(command: string): string {
    const escaped = command.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
    return `/bin/zsh -lc "${escaped}"`;
}

interface Playback {
    io: FakeCodexIo;
    turn: FakeTurn;
    /**
     * Replaces `{{cwd}}` in a step's text.
     */
    fill: (text: string) => string;
    cwd: string;
    stepsDone: number;
    outputChars: number;
}

/**
 * Reports the token usage of the model request the turn has made so far, which grows with the thread and with each step
 * the turn ran. `total` only has to differ between reports, since the Server counts each distinct total once.
 */
function reportUsage(playback: Playback) {
    const { io, turn, stepsDone, outputChars } = playback;
    const turnNumber = io.currentThread().turns.length;
    const inputTokens = 14_000 + 7500 * turnNumber + 2200 * stepsDone;
    const outputTokens = 180 + Math.ceil(outputChars / 4);
    io.notifyTurn(turn, 'thread/tokenUsage/updated', {
        turnId: turn.id,
        tokenUsage: {
            total: { totalTokens: turnNumber * 400_000 + stepsDone * 12_000 + outputTokens },
            last: {
                totalTokens: inputTokens + outputTokens,
                inputTokens,
                cachedInputTokens: Math.round(inputTokens * 0.86),
                outputTokens,
            },
            modelContextWindow: CONTEXT_WINDOW,
        },
    });
}

function commandItem(playback: Playback, command: string) {
    return {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: shellInvocation(playback.fill(command)),
        cwd: playback.cwd,
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
}

function playReasoning(playback: Playback, summary: readonly string[]) {
    const { io, turn } = playback;
    const reasoning = { type: 'reasoning', id: crypto.randomUUID(), summary: [], content: [] };
    io.startItem(turn, { ...reasoning });
    const parts = summary.map((part) => playback.fill(part));
    // Real Codex announces every summary part, including the first, before streaming its text.
    for (const [summaryIndex, delta] of parts.entries()) {
        io.notifyTurn(turn, 'item/reasoning/summaryPartAdded', {
            turnId: turn.id,
            itemId: reasoning.id,
            summaryIndex,
        });
        io.notifyTurn(turn, 'item/reasoning/summaryTextDelta', {
            turnId: turn.id,
            itemId: reasoning.id,
            delta,
            summaryIndex,
        });
    }
    io.completeItem(turn, { ...reasoning, summary: parts });
}

function playCommand(playback: Playback, step: Extract<FakeCodexScriptStep, { kind: 'command' }>) {
    const { io, turn } = playback;
    const item = commandItem(playback, step.command);
    io.startItem(turn, { ...item });
    const ran = step.shouldRun
        ? spawnSync('/bin/sh', ['-c', playback.fill(step.command)], {
              cwd: playback.cwd,
              encoding: 'utf8',
              env: process.env,
              timeout: 60_000,
          })
        : undefined;
    const exitCode = ran ? (ran.status ?? 1) : (step.exitCode ?? 0);
    io.completeItem(turn, {
        ...item,
        status: exitCode === 0 ? 'completed' : 'failed',
        aggregatedOutput: ran ? `${ran.stdout}${ran.stderr}` : playback.fill(step.output),
        exitCode,
        durationMs: step.durationMs ?? 1200,
    });
}

function playFileChange(
    playback: Playback,
    step: Extract<FakeCodexScriptStep, { kind: 'fileChange' }>,
) {
    const { io, turn } = playback;
    const item = {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'inProgress',
        changes: step.changes.map((change) => ({
            path: path.resolve(playback.cwd, playback.fill(change.path)),
            kind:
                change.kind === 'update'
                    ? { type: 'update', move_path: null }
                    : { type: change.kind },
            diff: playback.fill(change.diff),
        })),
    };
    io.startItem(turn, { ...item });
    io.completeItem(turn, { ...item, status: 'completed' });
}

/**
 * Whether the turn plays its next step: a declined approval and a failure end the script.
 */
type StepOutcome = 'continue' | 'stop';

/**
 * Asks for approval and waits: a command, or a file change with `paths`. A declined (or interrupted) one stops the
 * script.
 */
async function playApproval(
    playback: Playback,
    step: Extract<FakeCodexScriptStep, { kind: 'approval' }>,
): Promise<StepOutcome> {
    const { io, turn } = playback;
    if (step.paths)
        return playFileApproval(
            io,
            turn,
            step.paths.map((entry) => path.resolve(playback.cwd, playback.fill(entry))),
        );
    return playCommandApproval(
        io,
        turn,
        commandItem(playback, step.command),
        playback.fill(step.output),
    );
}

async function playHold(playback: Playback, file: string) {
    const { turn } = playback;
    // A running turn shows what it has used so far.
    reportUsage(playback);
    const target = path.join(process.env.FAKE_CODEX_CONTROL_DIR ?? '', file);
    while (!turn.interrupted && fs.existsSync(target)) {
        // eslint-disable-next-line no-await-in-loop -- the turn stays in progress until the file is removed
        await delay(HOLD_POLL_MS);
    }
}

/**
 * Plays one step.
 */
async function playStep(playback: Playback, step: FakeCodexScriptStep): Promise<StepOutcome> {
    const { io, turn } = playback;
    switch (step.kind) {
        case 'reasoning': {
            playReasoning(playback, step.summary);
            return 'continue';
        }
        case 'plan': {
            io.notifyTurn(turn, 'turn/plan/updated', {
                turnId: turn.id,
                explanation: null,
                plan: step.plan.map((entry) => ({ ...entry, step: playback.fill(entry.step) })),
            });
            return 'continue';
        }
        case 'command': {
            playCommand(playback, step);
            return 'continue';
        }
        case 'fileChange': {
            playFileChange(playback, step);
            return 'continue';
        }
        case 'approval': {
            return playApproval(playback, step);
        }
        case 'message': {
            const text = playback.fill(step.text);
            playback.outputChars += text.length;
            await io.streamMessage(turn, text, 0);
            return 'continue';
        }
        case 'hold': {
            await playHold(playback, step.file);
            return 'continue';
        }
        case 'fail': {
            turn.status = 'failed';
            turn.error = { message: playback.fill(step.message) };
            io.notifyTurn(turn, 'error', { turnId: turn.id, willRetry: false, error: turn.error });
            return 'stop';
        }
    }
}

/**
 * Plays a scripted turn's steps into `turn`, then reports the turn's token usage. The caller finishes the turn.
 */
export async function playScriptedTurn(
    io: FakeCodexIo,
    turn: FakeTurn,
    scripted: FakeCodexScriptTurn,
) {
    const cwd = process.cwd();
    const playback: Playback = {
        io,
        turn,
        fill: (text) => text.replaceAll('{{cwd}}', () => cwd),
        cwd,
        stepsDone: 0,
        outputChars: 0,
    };
    for (const step of scripted.steps) {
        if (turn.interrupted) break;
        // eslint-disable-next-line no-await-in-loop -- steps play one after another, in script order
        const outcome = await playStep(playback, step);
        playback.stepsDone += 1;
        if (outcome === 'stop') break;
    }
    if (turn.status === 'inProgress' && !turn.interrupted) reportUsage(playback);
    // The start moves back so the recorded start time agrees with the duration, but the duration itself is reported
    // as given: the caller's own `Date.now() - startedAt` drifted by a few milliseconds on a loaded runner.
    if (scripted.durationMs !== undefined) {
        turn.startedAt = Date.now() - scripted.durationMs;
        turn.scriptedDurationMs = scripted.durationMs;
    }
}
