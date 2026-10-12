import process from 'node:process';

/**
 * The models the fake Claude Code CLI's `initialize` lists: a default with three efforts, an `opus` alias that resolves
 * to a full model ID, and a model without effort control. Only the first two support Fast mode.
 */
export const FAKE_CLAUDE_MODEL = 'fake-claude-model';

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
 * The commands the fake CLI's `initialize` lists, including a terminal-bound one (`exit`) the Chat must leave out.
 */
export const FAKE_CLAUDE_COMMANDS = [
    {
        name: 'compact',
        description: 'Clear conversation history but keep a summary in context',
        argumentHint: '<optional custom summarization instructions>',
    },
    { name: 'review', description: 'Review a pull request', argumentHint: '' },
    { name: 'exit', description: 'Exit the REPL', argumentHint: '' },
];

/**
 * The effort the real CLI's `get_settings` reports as `applied.effort`: the session's level, the model default
 * (`medium`) when none was set, and `null` for a model without effort control.
 */
function appliedEffort({ model, effort }: { model: string; effort?: string }): string | null {
    const listed = FAKE_CLAUDE_MODELS.find(
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

/**
 * The answer to a control request that depends only on the session's model, effort, and ultracode (`initialize`,
 * `get_context_usage`, `get_settings`); `undefined` for every other request. Like Claude Code 2.1.296, `get_settings`
 * reports `ultracodeAvailable` and the applied `ultracode`, offering it only on a model with effort control.
 */
export function fakeClaudeSessionAnswer(
    subtype: unknown,
    session: { model: string; effort?: string; ultracode?: boolean; fastMode?: boolean },
): Record<string, unknown> | undefined {
    switch (subtype) {
        case 'initialize': {
            return {
                commands: FAKE_CLAUDE_COMMANDS,
                agents: [],
                models: FAKE_CLAUDE_MODELS,
                account: {},
                output_style: 'default',
                available_output_styles: ['default'],
                ...fakeClaudeFastMode(session),
            };
        }
        case 'get_context_usage': {
            return FAKE_CLAUDE_CONTEXT_USAGE;
        }
        case 'get_settings': {
            const isUltracodeAvailable =
                FAKE_CLAUDE_MODELS.find(
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
