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
 * Switches a running Claude Code in place: `setModel` applies from the next response, and the effort goes to the
 * session's flag settings layer, which outranks the user's settings files without writing to them. Returns the state
 * the snapshot reports once both are accepted.
 */
export async function configureClaudeModel(
    stream: Pick<Query, 'applyFlagSettings' | 'setModel'>,
    { model, effort }: AgentChatModelChange,
): Promise<AgentChatPatchOperation[]> {
    if (model) await withTimeout(stream.setModel(model.id), CONFIGURE_TIMEOUT_MS);
    if (effort)
        await withTimeout(
            stream.applyFlagSettings({ effortLevel: effort as EffortLevel }),
            CONFIGURE_TIMEOUT_MS,
        );
    const state = {
        ...(model && { model: model.resolvedId ?? model.id }),
        ...(effort && { effort }),
    };
    return [{ op: 'state', state }];
}
