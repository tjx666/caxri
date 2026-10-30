import type { AgentChatModel, AgentChatSnapshot } from '@caxri/protocol';

import { isRecord, stringField } from '../../chat-items';
import type { AcpToolPresentation } from '../acp/items';
import { acpConfigChoices, acpConfigValue, acpToolSubject, acpUsage } from '../acp/items';

/**
 * Antigravity's dialect of ACP (`agy acp`): its tool names, the `model` and `thought_level` config options that carry
 * the model and its effort, and its usage report. Inputs are untrusted JSON. Verified against `agy` 1.4.11.
 */

/**
 * Antigravity's own tool identifiers, which `agy acp` sends as a tool call's non-standard `name`, mapped to the tool
 * names every Chat surface already presents.
 */
const ANTIGRAVITY_TOOL_NAMES: Readonly<Record<string, string>> = {
    view_file: 'Read',
    read_file: 'Read',
    write_to_file: 'Write',
    create_file: 'Write',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'Edit',
    edit_file: 'Edit',
    list_dir: 'LS',
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
    const defaultEffort = acpConfigValue(configOptions, 'thought_level');
    return acpConfigChoices(configOptions, 'model').map(({ value, name }) => ({
        id: value,
        displayName: name,
        efforts,
        ...(defaultEffort && efforts.includes(defaultEffort) && { defaultEffort }),
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
 * Context usage from a `session/prompt` result's standard `usage.totalTokens`. `agy acp` reports no context window.
 */
export function antigravityUsage(
    result: unknown,
    respondedAt = Date.now(),
): AgentChatSnapshot['usage'] {
    const usage = isRecord(result) && isRecord(result.usage) ? result.usage : undefined;
    return acpUsage(usage?.totalTokens, undefined, ANTIGRAVITY_CACHE_TTL_MINUTES, respondedAt);
}
