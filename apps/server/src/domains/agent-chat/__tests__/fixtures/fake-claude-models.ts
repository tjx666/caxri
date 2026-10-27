import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { FakeClaudeUsage } from './fake-claude-io.ts';
import { fakeClaudeWindowAccount, fakeClaudeWindowUsage } from './fake-claude-window.ts';

/**
 * The models the fake Claude Code CLI's `initialize` lists: a default with three efforts, an `opus` alias that resolves
 * to a full model ID, and a model without effort control. Only the first two support Fast mode.
 */
const FAKE_CLAUDE_MODEL = 'fake-claude-model';

export const FAKE_CLAUDE_MODELS = [
    {
        value: FAKE_CLAUDE_MODEL,
        displayName: 'Fake',
        description: 'Fake model',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsFastMode: true,
    },
    {
        value: 'opus',
        resolvedModel: 'fake-claude-opus',
        displayName: 'Fake Opus',
        description: 'Fake alias',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
        supportsFastMode: true,
    },
    { value: 'fake-claude-haiku', displayName: 'Fake Haiku', description: 'No effort control' },
];

/**
 * The models the fake lists, with the default one renamed (its description becomes its display name) when a script
 * (`fake-claude-script.ts`) names its own; its other fields stay. `defaultModel` is the value the init message,
 * assistant messages, and results report.
 */
export function fakeClaudeModels(override?: { value: string; displayName: string }): {
    models: typeof FAKE_CLAUDE_MODELS;
    defaultModel: string;
} {
    const models = FAKE_CLAUDE_MODELS.map((model, index) =>
        index === 0 && override
            ? { ...model, ...override, description: override.displayName }
            : model,
    );
    return { models, defaultModel: override?.value ?? FAKE_CLAUDE_MODEL };
}

/**
 * The model a `set_model` request switches to: an alias resolves to its full model ID, any other value is used as is.
 */
export function resolveFakeClaudeModel(models: typeof FAKE_CLAUDE_MODELS, value: string): string {
    return models.find((model) => model.value === value)?.resolvedModel ?? value;
}

/**
 * The fake CLI's `get_context_usage` answer: two rows that fill the window, free space and a deferred tool schema the
 * Chat must leave out, and a 160K autocompact window below the model's 200K.
 */
const FAKE_CLAUDE_CONTEXT_USAGE = {
    categories: [
        { name: 'System prompt', tokens: 1500, color: 'gray', kind: 'used' },
        { name: 'Messages', tokens: 540, color: 'purple', kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 900, color: 'gray', kind: 'deferred' },
        { name: 'Free space', tokens: 157_960, color: 'gray', kind: 'free' },
    ],
    totalTokens: 2040,
    maxTokens: 200_000,
    rawMaxTokens: 160_000,
    percentage: 1,
    gridRows: [],
    model: FAKE_CLAUDE_MODEL,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
};

/**
 * The callback IDs the SDK registered per hook event in `initialize`.
 */
export function hookCallbackIds(hooks: unknown): Record<string, string[]> {
    const registered = Object.entries(
        (hooks ?? {}) as Record<string, Array<{ hookCallbackIds: string[] }>>,
    );
    return Object.fromEntries(
        registered.map(([event, matchers]) => [
            event,
            matchers.flatMap((matcher) => matcher.hookCallbackIds),
        ]),
    );
}

/**
 * One `hook_callback` control request. Like the real CLI, the turn's effort reaches an SDK host only through hook
 * input: an SDK-hosted init message never carries `effort`. The real CLI guarantees it only on tool-use hooks
 * (PreToolUse, Stop); this fixture reports it on the turn's UserPromptSubmit for simplicity, which the Server handles
 * the same way. An unset effort reports the model default, `medium`.
 */
export function hookCallbackRequest(
    callbackId: string,
    event: string,
    { effort, sessionId }: { effort: string | undefined; sessionId: string },
    fields: Record<string, unknown>,
): Record<string, unknown> {
    return {
        subtype: 'hook_callback',
        callback_id: callbackId,
        input: {
            hook_event_name: event,
            session_id: sessionId,
            cwd: process.cwd(),
            effort: { level: effort ?? 'medium' },
            ...fields,
        },
    };
}

/**
 * The commands the fake CLI's `initialize` lists, including a terminal-bound one (`exit`) the Chat must leave out and
 * Claude Code's built-in `/goal`, which the real CLI marks `builtin`.
 */
export const FAKE_CLAUDE_COMMANDS = [
    {
        name: 'compact',
        description: 'Clear conversation history but keep a summary in context',
        argumentHint: '<optional custom summarization instructions>',
    },
    { name: 'review', description: 'Review a pull request', argumentHint: '' },
    {
        name: 'goal',
        description: 'Set a goal and keep working until the condition is met',
        argumentHint: '',
        builtin: true,
    },
    { name: 'exit', description: 'Exit the REPL', argumentHint: '' },
];

/**
 * The effort the real CLI's `get_settings` reports as `applied.effort`: the session's level, the model default
 * (`medium`) when none was set, and `null` for a model without effort control.
 */
function appliedEffort({
    model,
    effort,
    models = FAKE_CLAUDE_MODELS,
}: {
    model: string;
    effort?: string;
    models?: typeof FAKE_CLAUDE_MODELS;
}): string | null {
    const listed = models.find(
        (candidate) => candidate.resolvedModel === model || candidate.value === model,
    );
    return listed?.supportsEffort === false ? null : (effort ?? 'medium');
}

/**
 * The Fast mode fields Claude Code adds to `initialize`, each init message, and each result. Under the Agent SDK it
 * reports `sdk_opt_in_required` until the host turns `fastMode` on through the flag settings.
 */
export function fakeClaudeFastMode(session: { fastMode?: boolean }): Record<string, unknown> {
    return session.fastMode
        ? { fast_mode_state: 'on' }
        : { fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' };
}

const HOUR = 3_600_000;

/**
 * The fake CLI's `/usage` answer (`get_usage`) for a Max plan: a 5-hour window at 22% and a weekly window at 10% with 5
 * days 3 hours to go, which is on pace. A `plan-behind-pace` file under `FAKE_CLAUDE_CONTROL_DIR` raises the weekly
 * window to 61%, below the 73% an even pace would leave, so the composers show the pace reminder. A
 * `plan-weekly-guarded` file reports the weekly window at 99.5% with 48 hours to go, which arms the weekly usage guard;
 * removing it returns the default answer, whose weekly window resets later and so lifts the guard.
 */
function fakeClaudeUsage(): Record<string, unknown> {
    const controlDirectory = process.env.FAKE_CLAUDE_CONTROL_DIR;
    const isBehindPace =
        controlDirectory !== undefined &&
        fs.existsSync(path.join(controlDirectory, 'plan-behind-pace'));
    const isGuarded =
        controlDirectory !== undefined &&
        fs.existsSync(path.join(controlDirectory, 'plan-weekly-guarded'));
    const now = Date.now();
    return {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
            five_hour: { utilization: 22, resets_at: new Date(now + 3 * HOUR).toISOString() },
            seven_day: {
                utilization: isGuarded ? 99.5 : isBehindPace ? 61 : 10,
                resets_at: new Date(now + (isGuarded ? 48 : 5 * 24 + 3) * HOUR).toISOString(),
            },
        },
    };
}

/**
 * Every token a response read, wrote, or replied with: the context the Server's meter shows after it.
 */
function contextTokens(usage: FakeClaudeUsage): number {
    return (
        usage.input_tokens +
        usage.output_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
    );
}

/**
 * The answer to a control request that depends only on the session's model, effort, and ultracode (`initialize`,
 * `get_context_usage`, `get_usage`, `get_settings`); `undefined` for every other request. Like Claude Code 2.1.296,
 * `get_settings` reports `ultracodeAvailable` and the applied `ultracode`, offering it only on a model with effort
 * control. A session with a scripted `usage` reports the context that usage fills, in place of the fixed total.
 */
export function fakeClaudeSessionAnswer(
    subtype: unknown,
    session: {
        model: string;
        effort?: string;
        ultracode?: boolean;
        fastMode?: boolean;
        isLargeContextTurn?: boolean;
        /**
         * The models to list, with the first as the default; `FAKE_CLAUDE_MODELS` when omitted.
         */
        models?: typeof FAKE_CLAUDE_MODELS;
        /**
         * The usage of the latest scripted response, whose tokens are the context `get_context_usage` reports.
         */
        usage?: FakeClaudeUsage;
    },
): Record<string, unknown> | undefined {
    const models = session.models ?? FAKE_CLAUDE_MODELS;
    switch (subtype) {
        case 'initialize': {
            return {
                commands: FAKE_CLAUDE_COMMANDS,
                agents: [],
                models,
                account: fakeClaudeWindowAccount() ?? {},
                output_style: 'default',
                available_output_styles: ['default'],
                ...fakeClaudeFastMode(session),
            };
        }
        case 'get_context_usage': {
            const report = { ...FAKE_CLAUDE_CONTEXT_USAGE, model: models[0].value };
            const totalTokens = session.usage
                ? contextTokens(session.usage)
                : session.isLargeContextTurn
                  ? 141_240
                  : undefined;
            if (totalTokens === undefined) return report;
            return {
                ...report,
                totalTokens,
                percentage: Math.round((totalTokens / report.rawMaxTokens) * 100),
                categories: report.categories.map((category) => ({
                    ...category,
                    tokens:
                        category.name === 'Messages'
                            ? totalTokens - 1500
                            : category.kind === 'free'
                              ? report.rawMaxTokens - totalTokens
                              : category.tokens,
                })),
            };
        }
        case 'get_usage': {
            return fakeClaudeWindowUsage() ?? fakeClaudeUsage();
        }
        case 'get_settings': {
            const isUltracodeAvailable =
                models.find(
                    (candidate) =>
                        candidate.resolvedModel === session.model ||
                        candidate.value === session.model,
                )?.supportsEffort === true;
            return {
                applied: {
                    model: session.model,
                    effort: appliedEffort(session),
                    ultracode: isUltracodeAvailable && session.ultracode === true,
                    ultracodeAvailable: isUltracodeAvailable,
                },
            };
        }
        default: {
            return undefined;
        }
    }
}
