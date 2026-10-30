import type {
    EffortLevel,
    HookCallbackMatcher,
    HookEvent,
    Query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
    AgentChatModel,
    AgentChatModelChange,
    AgentChatPatchOperation,
} from '@caxri/protocol';

import { boundedChatModels, clip, isRecord, stringField } from '../../chat-items';
import { withTimeout } from './prompt-queue';

const CONFIGURE_TIMEOUT_MS = 10_000;

/**
 * Maps the Agent SDK's `ModelInfo` list to the models a Chat can switch to. `value` is what `setModel` takes, often an
 * alias such as `opus`; `resolvedModel` is the full model the init message then reports, kept so the two still match.
 */
export function claudeChatModels(models: unknown): AgentChatModel[] {
    if (!Array.isArray(models)) return [];
    const mapped: AgentChatModel[] = [];
    for (const entry of models) {
        if (!isRecord(entry)) continue;
        const id = stringField(entry.value);
        if (!id) continue;
        const resolvedId = stringField(entry.resolvedModel);
        const description = stringField(entry.description);
        // Claude Code describes no speed-up, so the picker supplies its own wording.
        const fast = entry.supportsFastMode === true ? {} : undefined;
        const efforts =
            entry.supportsEffort !== false && Array.isArray(entry.supportedEffortLevels)
                ? entry.supportedEffortLevels.flatMap((effort) => {
                      const level = stringField(effort);
                      return level ? [level] : [];
                  })
                : [];
        mapped.push({
            id,
            displayName: stringField(entry.displayName) ?? id,
            ...(description && { description }),
            ...(resolvedId && resolvedId !== id && { resolvedId }),
            efforts,
            ...(fast && { fast }),
        });
    }
    return boundedChatModels(mapped);
}

/**
 * The `fast_mode_disabled_reason` values that still let this Chat turn Fast mode on. Under the Agent SDK Claude Code
 * reports `sdk_opt_in_required` until the host sets `fastMode` in the flag settings, which is exactly what the toggle
 * does; `pending` is an organization check still in flight. Every other reason (a free plan, a policy, a non-Anthropic
 * API, a model the organization disallows) withdraws the toggle.
 */
const FAST_MODE_REACHABLE_REASONS = new Set(['sdk_opt_in_required', 'pending']);

/**
 * The Fast mode state Claude Code reports with `initialize`, each init message, and each result: on (including the
 * `cooldown` after a rate limit, which resumes by itself), off, or withdrawn when something outside the Chat blocks it.
 * A message without `fast_mode_state` (an older CLI) reports nothing.
 */
export function claudeFastMode(message: unknown): AgentChatPatchOperation[] {
    if (!isRecord(message)) return [];
    const state = stringField(message.fast_mode_state);
    if (!state) return [];
    const reason = stringField(message.fast_mode_disabled_reason);
    const isReachable = reason === undefined || FAST_MODE_REACHABLE_REASONS.has(reason);
    const fast = state === 'off' ? (isReachable ? false : null) : true;
    return [{ op: 'state', state: { fast } }];
}

/**
 * Withdraws the Fast mode toggle while the account's extra usage is off. Claude Code serves Fast mode only on extra
 * usage, but under the Agent SDK it checks `sdk_opt_in_required` before the organization's status, so every message
 * reports that reason and hides `extra_usage_disabled` until the host opts in, which is what turning the toggle on
 * does. The same process's `/usage` answer says whether extra usage is on, so a Chat that reads it off offers no toggle
 * that could only fail. A Fast mode Claude Code reports as on stays visible so it can be turned off.
 */
export class ClaudeFastModeGate {
    private reported: boolean | null | undefined;
    private isExtraUsageOff = false;

    private offered(): boolean | null | undefined {
        return this.reported === false && this.isExtraUsageOff ? null : this.reported;
    }

    /**
     * Claude Code's operations with the Fast mode they report replaced by what the Chat offers.
     */
    report(operations: readonly AgentChatPatchOperation[]): AgentChatPatchOperation[] {
        return operations.map((operation) => {
            if (operation.op !== 'state' || operation.state.fast === undefined) return operation;
            this.reported = operation.state.fast;
            return { ...operation, state: { ...operation.state, fast: this.offered() } };
        });
    }

    /**
     * The operation that updates the toggle after a `/usage` answer, or none when the toggle does not change.
     */
    setExtraUsage(isEnabled: boolean): AgentChatPatchOperation[] {
        const before = this.offered();
        this.isExtraUsageOff = !isEnabled;
        const fast = this.offered();
        return fast === before ? [] : [{ op: 'state', state: { fast } }];
    }
}

/**
 * The model, effort, and Fast mode an init message reports. Only a CLI that publishes the effort it will send includes
 * one, and the newest init wins.
 */
export function claudeInitState(message: Record<string, unknown>): AgentChatPatchOperation[] {
    const model = stringField(message.model);
    const effort = stringField(message.effort);
    return [
        ...(model ? [{ op: 'state' as const, state: { model: clip(model, 200) } }] : []),
        ...(effort ? [{ op: 'state' as const, state: { effort: clip(effort, 40) } }] : []),
        ...claudeFastMode(message),
    ];
}

/**
 * The effort a hook reports for the turn it fires in. The SDK's init carries `effort` only on Remote Control bridge
 * frames, so a Chat learns the level Claude Code actually sends (after settings, env overrides, and model downgrades)
 * from hook input instead. A subagent's hook reports its own effort, not the Chat's, so it is ignored.
 */
function claudeHookEffort(input: unknown): AgentChatPatchOperation[] {
    if (!isRecord(input) || input.agent_id !== undefined || !isRecord(input.effort)) return [];
    const effort = stringField(input.effort.level);
    return effort ? [{ op: 'state', state: { effort: clip(effort, 40) } }] : [];
}

/**
 * Read-only hook callbacks that report the turn's effective effort. Claude Code fills `effort` only for a hook that
 * runs with a tool-use context: PreToolUse and Stop always do, UserPromptSubmit only on some paths, so it is a
 * best-effort early report and Stop is the guaranteed one. Each returns an empty output, so Claude Code proceeds
 * exactly as without them.
 */
export function claudeEffortHooks(
    apply: (operations: AgentChatPatchOperation[]) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const matcher: HookCallbackMatcher = {
        hooks: [
            (input) => {
                apply(claudeHookEffort(input));
                return Promise.resolve({});
            },
        ],
    };
    return { UserPromptSubmit: [matcher], PreToolUse: [matcher], Stop: [matcher] };
}

/**
 * The effort and ultracode Claude Code will apply on its next request: `get_settings`' `applied`, after settings, env
 * overrides, organization caps, and model downgrades. Hooks only report the effort once a turn runs, so this is what
 * names the effort of a Chat that was just started or resumed. Agent SDK 0.3.295 implements `Query.getSettings` without
 * declaring it, so it is read structurally; a missing method or a model without effort reports nothing. Ultracode is
 * offered only while `applied.ultracodeAvailable` is true (Claude Code 2.1.296 reports both keys); any other answer
 * withdraws it, so the toggle never outlives a switch to a model without it.
 */
export async function readClaudeAppliedSettings(stream: Query): Promise<AgentChatPatchOperation[]> {
    const { getSettings } = stream as Query & { getSettings?: () => Promise<unknown> };
    if (typeof getSettings !== 'function') return [];
    const settings = await withTimeout(getSettings.call(stream), CONFIGURE_TIMEOUT_MS);
    if (!isRecord(settings) || !isRecord(settings.applied)) return [];
    const { applied } = settings;
    const effort = stringField(applied.effort);
    const ultracode = applied.ultracodeAvailable === true ? applied.ultracode === true : null;
    return [{ op: 'state', state: { ...(effort && { effort: clip(effort, 40) }), ultracode } }];
}

/**
 * Switches a running Claude Code in place: `setModel` applies from the next response, and the effort, ultracode, and
 * Fast mode go to the session's flag settings layer, which outranks the user's settings files without writing to them
 * (`apply_flag_settings` merges into that layer, so each key stays until it is sent again). Each step reports its state
 * as soon as Claude Code accepts it, so a failed effort change still shows the model that did switch.
 *
 * An `effortLevel` sent without an `ultracode` key turns ultracode off, so an effort change carries the current
 * ultracode along to keep it on, the way Claude Code's own `/effort` picker does.
 */
export async function configureClaudeModel(
    stream: Pick<Query, 'applyFlagSettings' | 'setModel'>,
    { model, effort, ultracode, fast }: AgentChatModelChange,
    current: { ultracode: boolean | undefined },
    apply: (operations: AgentChatPatchOperation[]) => void,
): Promise<void> {
    if (model) {
        await withTimeout(stream.setModel(model.id), CONFIGURE_TIMEOUT_MS);
        apply([{ op: 'state', state: { model: model.resolvedId ?? model.id } }]);
    }
    const nextUltracode = ultracode ?? (effort ? current.ultracode : undefined);
    if (!effort && nextUltracode === undefined && fast === undefined) return;
    await withTimeout(
        stream.applyFlagSettings({
            ...(effort && { effortLevel: effort as EffortLevel }),
            ...(nextUltracode !== undefined && { ultracode: nextUltracode }),
            ...(fast !== undefined && { fastMode: fast }),
        }),
        CONFIGURE_TIMEOUT_MS,
    );
    apply([
        {
            op: 'state',
            state: {
                ...(effort && { effort }),
                ...(nextUltracode !== undefined && { ultracode: nextUltracode }),
                ...(fast !== undefined && { fast }),
            },
        },
    ]);
}
