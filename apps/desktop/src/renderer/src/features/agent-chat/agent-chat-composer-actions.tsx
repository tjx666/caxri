import type { AgentChatSnapshot } from '@caxri/protocol';
import { ArrowUp, CornerDownLeft } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { AgentChatAttachButton } from './agent-chat-attach-button';
import { agentChatContextUsage } from './agent-chat-context';
import { AgentChatContextMeter } from './agent-chat-context-meter';
import { AgentChatModelMenu } from './agent-chat-model-menu';
import { AgentChatPermissionMenu } from './agent-chat-permission-menu';
import {
    AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME,
    AgentChatStopButton,
} from './agent-chat-stop-button';

/**
 * Sends the form. `aria-disabled` rather than `disabled`: a natively disabled button gets no pointer events in
 * Chromium, so its tooltip, the one place that says why Send is unavailable, would never open. The composer's `submit`
 * refuses an unsendable draft itself.
 */
function AgentChatSendButton({
    isSendable,
    sendAction,
    tooltip,
}: {
    isSendable: boolean;
    sendAction: { label: string; tooltip: string };
    tooltip: string;
}) {
    return (
        <Tooltip content={tooltip}>
            <Button
                aria-disabled={!isSendable || undefined}
                aria-label={sendAction.label}
                className={AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME}
                size="icon"
                type="submit"
                variant="ghost"
            >
                {sendAction.label === 'Queue message' ? (
                    <CornerDownLeft className="size-4" strokeWidth={2.25} />
                ) : (
                    <ArrowUp className="size-4" strokeWidth={2.25} />
                )}
            </Button>
        </Tooltip>
    );
}

/**
 * The composer card's bottom row: attach, the context meter, and the model menu on the right, then one primary action
 * slot that holds Stop while a turn runs and nothing is typed, and Send otherwise.
 */
export function AgentChatComposerActions({
    canAttachImages,
    isAttaching,
    isSendable,
    isStopping,
    onCompact,
    onPick,
    onStop,
    sendAction,
    sendTooltip,
    showsStop,
    snapshot,
    terminalId,
}: {
    /**
     * Whether the provider accepts images, which decides what Attach files says it does.
     */
    canAttachImages: boolean;
    /**
     * Whether picked images are still being read or a long paste saved, which turns Attach files into a spinner.
     */
    isAttaching: boolean;
    isSendable: boolean;
    isStopping: boolean;
    /**
     * Runs the provider's compact command, or `undefined` when the provider has none or the Chat refuses it now.
     */
    onCompact: (() => void) | undefined;
    /**
     * Routes picked files: images attach, anything else is cited by path.
     */
    onPick: (files: readonly File[]) => void;
    onStop: () => void;
    sendAction: { label: string; tooltip: string };
    sendTooltip: string;
    showsStop: boolean;
    snapshot:
        | Pick<
              AgentChatSnapshot,
              | 'activeTurnId'
              | 'effort'
              | 'model'
              | 'models'
              | 'permissionMode'
              | 'planMode'
              | 'usage'
          >
        | undefined;
    terminalId: string;
}) {
    const contextUsage = agentChatContextUsage(snapshot);
    return (
        <div className="flex items-center gap-1 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
                <AgentChatAttachButton
                    canAttachImages={canAttachImages}
                    isBusy={isAttaching}
                    onPick={onPick}
                />
                {contextUsage && (
                    <AgentChatContextMeter onCompact={onCompact} usage={contextUsage} />
                )}
                <AgentChatPermissionMenu snapshot={snapshot} terminalId={terminalId} />
                <AgentChatModelMenu snapshot={snapshot} terminalId={terminalId} />
            </div>
            {showsStop ? (
                <AgentChatStopButton isStopping={isStopping} onStop={onStop} />
            ) : (
                <AgentChatSendButton
                    isSendable={isSendable}
                    sendAction={sendAction}
                    tooltip={sendTooltip}
                />
            )}
        </div>
    );
}
