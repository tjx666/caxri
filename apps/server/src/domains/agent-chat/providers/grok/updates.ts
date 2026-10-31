import { clip, stringField } from '../../chat-items';
import { isQueuedPromptUuid } from '../../queued-prompt-uuid';
import type { AcpUpdates } from '../acp/updates';
import { stopReasonStatus } from '../acp/updates';

type Json = Record<string, unknown>;

/**
 * Applies Grok Build's own updates (`_x.ai/session_notification` live, `_x.ai/session/update` when replayed).
 * `onInteractionResolved` runs when Grok Build settled a permission request itself (another client answered it, or the
 * turn moved on).
 */
export function applyGrokExtensionUpdate(
    updates: AcpUpdates,
    update: Json,
    onInteractionResolved: (toolCallId: string) => void,
): void {
    switch (update.sessionUpdate) {
        case 'turn_completed': {
            const turn = updates.replayedTurn();
            if (!turn) return;
            updates.closeStreaming();
            turn.status = stopReasonStatus(update.stop_reason);
            // The replayed `prompt_id` is the `promptId` the prompt was sent with, which carries a queued mark.
            const promptId = stringField(update.prompt_id);
            const message = updates.replayedItem(`${turn.id}:user`);
            if (promptId && isQueuedPromptUuid(promptId) && message?.type === 'userMessage')
                updates.setReplayedItem({ ...message, delivery: 'queued' });
            if (typeof update.elapsed_ms === 'number' && update.elapsed_ms >= 0)
                turn.durationMs = update.elapsed_ms;
            return;
        }
        case 'interaction_resolved': {
            const key = stringField(update.toolCallId);
            if (key) onInteractionResolved(key);
            return;
        }
        case 'model_changed': {
            const model = stringField(update.model_id);
            if (model) updates.applyState({ model: clip(model, 200) });
            return;
        }
        default: {
            // Hook runs, retries, background tasks, and response markers are not conversation content.
        }
    }
}
