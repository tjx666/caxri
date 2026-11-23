import type { AgentChatModel, AgentChatPermission, AgentChatSnapshot } from '@caxri/protocol';

import { isRecord, stringField } from '../../chat-items';
import type { AcpToolCall, AcpToolPresentation } from '../acp/items';
import { acpConfigChoices, acpConfigValue, acpToolSubject, acpUsage } from '../acp/items';

/**
 * Antigravity's dialect of ACP (`agy acp`): its tool names, the `model` and `thought_level` config options that carry
 * the model and its effort, its session modes, its plan artifact, and its usage report. Inputs are untrusted JSON.
 * Verified against `agy` 1.5.14.
 */

/**
 * Antigravity's own tool identifiers, which `agy acp` sends as a tool call's non-standard `name`, mapped to the tool
 * names every Chat surface already presents.
 */
const ANTIGRAVITY_TOOL_NAMES: Readonly<Record<string, string>> = {
    view_file: 'Read',
    read_file: 'Read',
    write_to_file: 'Write',
    write_file: 'Write',
    create_file: 'Write',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'Edit',
    edit_file: 'Edit',
    list_dir: 'LS',
    run_command: 'Bash',
    grep_search: 'Grep',
    find_by_name: 'Glob',
    command_status: 'BashOutput',
    search_web: 'WebSearch',
    read_url_content: 'WebFetch',
};

/**
 * Antigravity names tool arguments in PascalCase (`CommandLine`, `AbsolutePath`).
 */
const ANTIGRAVITY_SUBJECT_FIELDS = [
    'CommandLine',
    'AbsolutePath',
    'TargetFile',
    'Path',
    'DirectoryPath',
    'SearchPath',
    'Pattern',
    'Query',
    'Url',
] as const;

export const antigravityToolPresentation: AcpToolPresentation = {
    nameAndSubject: (call) => {
        const subject = acpToolSubject(call.rawInput, ANTIGRAVITY_SUBJECT_FIELDS);
        const name =
            (call.toolName && ANTIGRAVITY_TOOL_NAMES[call.toolName]) ??
            call.toolName ??
            (call.title || call.kind);
        return { name, ...(subject && { subject }) };
    },
    /**
     * Antigravity titles a shell call with the command itself; the raw input carries it as `CommandLine`.
     */
    shellCommand: (call) => stringField(call.rawInput.CommandLine) ?? call.title,
    /**
     * A declined command goes back to `in_progress` and the turn ends without it, so only the Chat's own record of the
     * user's answer marks it declined.
     */
    isRejected: () => false,
};

/**
 * The models a `configOptions` list offers, each with the thinking levels its `thought_level` option lists. `agy acp`
 * also lists every model and level pair in `models`, which the picker would show as separate models.
 */
export function antigravityModels(configOptions: unknown): AgentChatModel[] {
    const efforts = acpConfigChoices(configOptions, 'thought_level').map(({ value }) => value);
    const current = acpConfigValue(configOptions, 'thought_level');
    const defaultEffort = current && efforts.includes(current) ? current : undefined;
    return acpConfigChoices(configOptions, 'model').map(({ value, name }) => ({
        id: value,
        displayName: name,
        efforts,
        ...(defaultEffort && { defaultEffort }),
    }));
}

/**
 * The model and effort a `configOptions` list (a `session/new`, `session/load`, or `session/set_config_option` result,
 * or a `config_option_update`) reports as current.
 */
export function antigravityConfigState(configOptions: unknown): Partial<AgentChatSnapshot> {
    const model = acpConfigValue(configOptions, 'model');
    const effort = acpConfigValue(configOptions, 'thought_level');
    return { ...(model && { model }), ...(effort && { effort }) };
}

/**
 * How long Gemini's prompt cache is assumed to survive an idle Antigravity Chat, in minutes: the Gemini API's default
 * cache lifetime. Antigravity reports no expiry, so this is an estimate that drives the composer's cache notice only.
 *
 * @see https://ai.google.dev/gemini-api/docs/caching
 */
const ANTIGRAVITY_CACHE_TTL_MINUTES = 60;

/**
 * Context usage: the latest `usage_update` (`context`) when `agy acp` sent one, which counts what the conversation
 * holds against the model's window, otherwise a `session/prompt` result's standard `usage.totalTokens`.
 */
export function antigravityUsage(
    result: unknown,
    context: { used: number; size: number } | undefined,
    respondedAt = Date.now(),
): AgentChatSnapshot['usage'] {
    const usage = isRecord(result) && isRecord(result.usage) ? result.usage : undefined;
    return acpUsage(
        context?.used ?? usage?.totalTokens,
        context?.size,
        ANTIGRAVITY_CACHE_TTL_MINUTES,
        respondedAt,
    );
}

/**
 * `agy acp`'s session modes (`session/set_mode`), which carry both the Chat's permission level and its plan mode.
 * `--dangerously-skip-permissions` is a launch flag rather than a mode, so full access runs in `default`.
 */
export type AntigravityMode = 'default' | 'accept-edits' | 'auto' | 'plan';

/**
 * The session mode a Chat permission runs in: plan mode wins over the level, as it does in Antigravity's own TUI.
 */
export function antigravityMode(permission: AgentChatPermission): AntigravityMode {
    if (permission.planMode) return 'plan';
    switch (permission.permissionMode) {
        case 'ask': {
            return 'default';
        }
        case 'auto': {
            return 'auto';
        }
        case 'acceptEdits': {
            return 'accept-edits';
        }
        default: {
            return 'default';
        }
    }
}

/**
 * The Chat permission a reported session mode means. A process launched with full access asks nothing in any mode but
 * `plan`, so its level stays `fullAccess`; plan mode keeps the level the Chat returns to.
 */
export function antigravityPermission(
    modeId: string,
    current: AgentChatPermission,
    isFullAccess: boolean,
): AgentChatPermission | undefined {
    if (modeId === 'plan') return { ...current, planMode: true };
    const levels: Readonly<Record<string, AgentChatPermission['permissionMode']>> = {
        'default': 'ask',
        'accept-edits': 'acceptEdits',
        'auto': 'auto',
    };
    if (!(modeId in levels)) return undefined;
    return { permissionMode: isFullAccess ? 'fullAccess' : levels[modeId], planMode: false };
}

/**
 * The plan a finished `write_file` call proposes: in plan mode Antigravity writes its plan as an artifact whose
 * `ArtifactMetadata.RequestFeedback` asks the user to review it before it builds anything.
 */
export function antigravityProposedPlan(call: AcpToolCall): string | undefined {
    if (call.toolName !== 'write_file') return undefined;
    const metadata = isRecord(call.rawInput.ArtifactMetadata)
        ? call.rawInput.ArtifactMetadata
        : undefined;
    if (metadata?.RequestFeedback !== true) return undefined;
    const plan = stringField(call.rawInput.Content)?.trim();
    return plan === '' ? undefined : plan;
}

/**
 * Whether a failed prompt is Antigravity refusing the turn on a used-up quota (its `You have exhausted your quota on
 * this model.`, or the Gemini API's `RESOURCE_EXHAUSTED`), rather than an outage or a rate limit it retries itself.
 */
export function isAntigravityUsageLimitError(message: string): boolean {
    return /exhausted your quota|quota exhausted|resource_exhausted/iu.test(message);
}

/**
 * The `_meta` that appends `instructions` to Antigravity's system prompt on `session/new` and `session/load`, when the
 * `initialize` result advertises `agentCapabilities._meta.antigravity.systemPrompt.append`. Verified on agy 1.5.14,
 * which then follows the appended text. Without that capability, or without instructions, the sessions open unchanged.
 */
export function antigravitySystemPromptMeta(
    initialized: Record<string, unknown>,
    instructions: string | undefined,
): Record<string, unknown> | undefined {
    if (!instructions) return undefined;
    const capabilities = isRecord(initialized.agentCapabilities)
        ? initialized.agentCapabilities
        : undefined;
    const meta = capabilities && isRecord(capabilities._meta) ? capabilities._meta : undefined;
    const antigravity = meta?.antigravity;
    const systemPrompt = isRecord(antigravity) ? antigravity.systemPrompt : undefined;
    if (!isRecord(systemPrompt) || systemPrompt.append !== true) return undefined;
    return { antigravity: { systemPrompt: { append: instructions } } };
}
