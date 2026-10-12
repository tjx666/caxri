import type { AgentChatSnapshot } from '@caxri/protocol';
import { ArrowUp, CornerDownLeft } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTerminal } from '../../stores/selectors';
import type { SessionReferenceCandidate } from '../session/session-reference';
import { AgentChatAddMenu, AgentChatPlanChip } from './agent-chat-add-menu';
import { agentChatContextUsage } from './agent-chat-context';
import { AgentChatContextMeter } from './agent-chat-context-meter';
import { AgentChatModelMenu } from './agent-chat-model-menu';
import { AgentChatPermissionMenu } from './agent-chat-permission-menu';
import {
    AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME,
    AgentChatStopButton,
} from './agent-chat-stop-button';
import { useAgentChatPermissionSelection } from './hooks/use-agent-chat-permission-selection';

/**
 * Sends the form. `aria-disabled` rather than `disabled`: a natively disabled button gets no pointer events in
 * Chromium, so its tooltip, the one place that says why Send is unavailable, would never open. The composer's `submit`
 * refuses an unsendable draft itself.
 */
function AgentChatSendButton({
    isQueueing,
    isSendable,
    sendAction,
    tooltip,
}: {
    isQueueing: boolean;
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
                {isQueueing ? (
                    <CornerDownLeft className="size-4" strokeWidth={2.25} />
                ) : (
                    <ArrowUp className="size-4" strokeWidth={2.25} />
                )}
            </Button>
        </Tooltip>
    );
}

/**
 * The composer card's bottom row, laid out like the Codex app's: `+`, the Plan chip while plan mode is on, and the
 * permission menu lead on the left; the context meter, the model menu, and one primary action slot trail on the right.
 * That slot holds Stop while a turn runs and nothing is typed, and Send otherwise. The permission selection lives here
 * because both the permission menu (the level) and `+` (plan mode) switch it, and they must share one optimistic
 * state.
 */
export function AgentChatComposerActions({
    canAttachImages,
    canSaveProjectDefault,
    isAttaching,
    isQueueing,
    isSendable,
    isStopping,
    onCompact,
    onGoal,
    onPick,
    onReferenceSession,
    onStop,
    recentSessions,
    sendAction,
    sendTooltip,
    showsStop,
    snapshot,
    terminalId,
}: {
    /**
     * Whether the provider accepts images, which decides what Files in `+` says it does.
     */
    canAttachImages: boolean;
    /**
     * Whether the permission menu offers "Use as Project default" (`AgentChatHostCapabilities`).
     */
    canSaveProjectDefault: boolean;
    /**
     * Whether picked images are still being read, a long paste saved, or a Session reference written, which turns `+`
     * into a spinner.
     */
    isAttaching: boolean;
    /**
     * Whether Send queues the message rather than sending it now, which swaps its glyph. Decided from the Chat's state
     * rather than the action's label, which is translated display text.
     */
    isQueueing: boolean;
    isSendable: boolean;
    isStopping: boolean;
    /**
     * Runs the provider's compact command, or `undefined` when the provider has none or the Chat refuses it now.
     */
    onCompact: (() => void) | undefined;
    /**
     * Turns the draft into the provider's goal command, or `undefined` when the provider reports none.
     */
    onGoal: (() => void) | undefined;
    /**
     * Routes picked files: images attach, anything else is cited by path.
     */
    onPick: (files: readonly File[]) => void;
    onReferenceSession: (candidate: SessionReferenceCandidate) => void;
    onStop: () => void;
    /**
     * The recently opened Sessions `+` offers to cite.
     */
    recentSessions: readonly SessionReferenceCandidate[];
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
    const terminal = useTerminal(terminalId);
    const provider = terminal && terminal.kind !== 'shell' ? terminal.kind : undefined;
    const permission = useAgentChatPermissionSelection(snapshot, provider, terminalId);
    const planMode = permission.snapshot?.planMode;
    return (
        <div className="flex items-center gap-1 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
                <AgentChatAddMenu
                    canAttachImages={canAttachImages}
                    isBusy={isAttaching}
                    onGoal={onGoal}
                    onPick={onPick}
                    onReferenceSession={onReferenceSession}
                    sessions={recentSessions}
                    planMode={
                        planMode === undefined
                            ? undefined
                            : {
                                  isOn: planMode,
                                  onChange: (isOn) => permission.configure({ planMode: isOn }),
                              }
                    }
                />
                {planMode && (
                    <AgentChatPlanChip
                        onTurnOff={() => permission.configure({ planMode: false })}
                    />
                )}
                <AgentChatPermissionMenu
                    canSaveProjectDefault={canSaveProjectDefault}
                    provider={provider}
                    selection={permission}
                    terminalId={terminalId}
                />
            </div>
            <div className="flex min-w-0 items-center gap-0.5">
                {contextUsage && (
                    <AgentChatContextMeter onCompact={onCompact} usage={contextUsage} />
                )}
                <AgentChatModelMenu snapshot={snapshot} terminalId={terminalId} />
            </div>
            {showsStop ? (
                <AgentChatStopButton isStopping={isStopping} onStop={onStop} />
            ) : (
                <AgentChatSendButton
                    isQueueing={isQueueing}
                    isSendable={isSendable}
                    sendAction={sendAction}
                    tooltip={sendTooltip}
                />
            )}
        </div>
    );
}
