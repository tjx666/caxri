import type { EffortLevel, Query } from '@anthropic-ai/claude-agent-sdk';
import type {
    AgentChatModel,
    AgentChatModelChange,
    AgentChatPatchOperation,
} from '@caxri/protocol';

import { boundedChatModels, clip, isRecord, stringField } from './chat-items';
import { withTimeout } from './claude-prompt-queue';

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
        });
    }
    return boundedChatModels(mapped);
}

/**
 * The effort an init message reports. Only a CLI that publishes the effort it will send includes one, and the newest
 * init wins.
 */
export function claudeInitEffort(message: Record<string, unknown>): AgentChatPatchOperation[] {
    const effort = stringField(message.effort);
    return effort ? [{ op: 'state', state: { effort: clip(effort, 40) } }] : [];
}

/**
 * The effort a hook reports for the turn it fires in. The SDK's init carries `effort` only on Remote Control bridge
 * frames, so a Chat learns the level Claude Code actually sends (after settings, env overrides, and model downgrades)
 * from hook input instead. A subagent's hook reports its own effort, not the Chat's, so it is ignored.
 */
export function claudeHookEffort(input: unknown): AgentChatPatchOperation[] {
    if (!isRecord(input) || input.agent_id !== undefined || !isRecord(input.effort)) return [];
    const effort = stringField(input.effort.level);
    return effort ? [{ op: 'state', state: { effort: clip(effort, 40) } }] : [];
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
 * Switches a running Claude Code in place: `setModel` applies from the next response, and the effort and ultracode go
 * to the session's flag settings layer, which outranks the user's settings files without writing to them. Each step
 * reports its state as soon as Claude Code accepts it, so a failed effort change still shows the model that did
 * switch.
 *
 * An `effortLevel` sent without an `ultracode` key turns ultracode off, so an effort change carries the current
 * ultracode along to keep it on, the way Claude Code's own `/effort` picker does.
 */
export async function configureClaudeModel(
    stream: Pick<Query, 'applyFlagSettings' | 'setModel'>,
    { model, effort, ultracode }: AgentChatModelChange,
    current: { ultracode: boolean | undefined },
    apply: (operations: AgentChatPatchOperation[]) => void,
): Promise<void> {
    if (model) {
        await withTimeout(stream.setModel(model.id), CONFIGURE_TIMEOUT_MS);
        apply([{ op: 'state', state: { model: model.resolvedId ?? model.id } }]);
    }
    const nextUltracode = ultracode ?? (effort ? current.ultracode : undefined);
    if (!effort && nextUltracode === undefined) return;
    await withTimeout(
        stream.applyFlagSettings({
            ...(effort && { effortLevel: effort as EffortLevel }),
            ...(nextUltracode !== undefined && { ultracode: nextUltracode }),
        }),
        CONFIGURE_TIMEOUT_MS,
    );
    apply([
        {
            op: 'state',
            state: {
                ...(effort && { effort }),
                ...(nextUltracode !== undefined && { ultracode: nextUltracode }),
            },
        },
    ]);
}
