import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { Goal, Lightbulb } from 'lucide-react';

import { Separator } from '../../../components/ui/separator';
import { useTranslation } from '../../../i18n';
import { useCommandShortcut } from '../../../lib/keybindings';
import { useTerminal } from '../../../stores/selectors';
import type { SessionReferenceCandidate } from '../../session/session-reference';
import { AgentChatStopButton } from '../agent-chat-stop-button';
import { agentChatContextUsage } from '../context/agent-chat-context';
import { AgentChatContextMeter } from '../context/agent-chat-context-meter';
import { useAgentChatComposerCommand } from '../hooks/use-agent-chat-composer-command';
import { AgentChatModelMenu } from '../model/agent-chat-model-menu';
import { AgentChatPermissionMenu } from '../permissions/agent-chat-permission-menu';
import { useAgentChatPermissionSelection } from '../permissions/use-agent-chat-permission-selection';
import { openAgentChatContext, openAgentChatSideChat } from '../tasks/agent-chat-task-opener';
import { AgentChatAddMenu, AgentChatModeChip } from './agent-chat-add-menu';
import { AgentChatSendButton } from './send/agent-chat-send-button';
import type { AgentChatSendKey } from './send/agent-chat-send-tooltip';

/**
 * The composer card's bottom row, laid out like the Codex app's: `+`, the Plan chip while plan mode is on, and the
 * permission menu lead on the left; the context meter, the model menu, and one primary action slot trail on the right.
 * That slot holds Stop while a turn runs and nothing is typed, and Send otherwise. The permission selection lives here
 * because both the permission menu (the level) and `+` (plan mode) switch it, and they must share one optimistic state;
 * `agentChat.togglePlanMode` flips plan mode through it too, and the Plan chip shows the result.
 */
export function AgentChatComposerActions({
    canAttachImages,
    canOpenContext,
    caxriSkill,
    canSaveProjectDefault,
    isAttaching,
    isQueueing,
    isResume,
    isSendable,
    isStopping,
    onCompact,
    onGoal,
    onTurnOffGoalMode,
    onPick,
    onPickPaths,
    onPicked,
    onReferenceSession,
    onStop,
    recentSessions,
    sendAction,
    sendKeys,
    sendShortcut,
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
     * Whether the context meter offers Details (`AgentChatHostCapabilities`).
     */
    canOpenContext: boolean;
    /**
     * Whether the permission menu offers "Use as Project default" (`AgentChatHostCapabilities`).
     */
    canSaveProjectDefault: boolean;
    /**
     * The Caxri skill card `+` toggles.
     */
    caxriSkill: { isAttached: boolean; onChange: (isAttached: boolean) => void };
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
    /**
     * Send continues the stopped or failed turn (`isAgentChatTurnResumable`) instead of sending the empty draft.
     */
    isResume: boolean;
    isSendable: boolean;
    isStopping: boolean;
    /**
     * Runs the provider's compact command, or `undefined` when the provider has none or the Chat refuses it now.
     */
    onCompact: (() => void) | undefined;
    /**
     * Puts the composer in Goal mode, or `undefined` when the provider reports no goal command.
     */
    onGoal: (() => void) | undefined;
    /**
     * Leaves Goal mode; defined only while it is on, which shows the Goal chip.
     */
    onTurnOffGoalMode: (() => void) | undefined;
    /**
     * Routes picked files: images attach, anything else is cited by path.
     */
    onPick: (files: readonly File[]) => void;
    /**
     * Opens the panel for files and folders together (`useAgentChatFileInput`'s `pickPaths`), or `undefined` in an SSH
     * Host window.
     */
    onPickPaths: (() => Promise<unknown>) | undefined;
    /**
     * Runs after a pick lands (the input takes focus back from the menu or native panel).
     */
    onPicked: () => void;
    onReferenceSession: (candidate: SessionReferenceCandidate) => void;
    onStop: () => void;
    /**
     * The recently opened Sessions `+` offers to cite.
     */
    recentSessions: readonly SessionReferenceCandidate[];
    sendAction: { kind?: 'queue' | 'send' | 'steer'; label: string; tooltip: string };
    /**
     * The running turn's keys the Send tooltip lists (`agentChatSendTooltipKeys`).
     */
    sendKeys: readonly AgentChatSendKey[] | undefined;
    /**
     * The keycap beside {@link sendTooltip}, absent while the tooltip says why Send cannot act.
     */
    sendShortcut: string | undefined;
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
    const { t } = useTranslation();
    const planModeShortcut = useCommandShortcut('agentChat.togglePlanMode');
    const contextUsage = agentChatContextUsage(snapshot);
    const terminal = useTerminal(terminalId);
    const provider = terminal && terminal.kind !== 'shell' ? terminal.kind : undefined;
    const permission = useAgentChatPermissionSelection(snapshot, provider, terminalId);
    const planMode = permission.snapshot?.planMode;
    useAgentChatComposerCommand(terminalId, 'togglePlanMode', planMode !== undefined, () =>
        permission.configure({ planMode: !planMode }),
    );
    const hasSideChat =
        provider !== undefined && agentProviderCatalog[provider].capabilities.chatSideQuestion;
    useAgentChatComposerCommand(terminalId, 'openSideChat', hasSideChat, () =>
        openAgentChatSideChat(terminalId),
    );
    return (
        <div className="flex items-center gap-1 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
                <AgentChatAddMenu
                    canAttachImages={canAttachImages}
                    caxriSkill={caxriSkill}
                    isBusy={isAttaching}
                    onGoal={onGoal}
                    onPick={(files) => {
                        onPick(files);
                        onPicked();
                    }}
                    onPickPaths={
                        onPickPaths &&
                        (() => {
                            void onPickPaths().then(onPicked);
                        })
                    }
                    onReferenceSession={onReferenceSession}
                    onSideChat={hasSideChat ? () => openAgentChatSideChat(terminalId) : undefined}
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
                    <AgentChatModeChip
                        icon={Lightbulb}
                        label={t('agentChat.permission.plan')}
                        name={t('agentChat.permission.planMode')}
                        shortcut={planModeShortcut}
                        turnOffLabel={t('agentChat.add.turnOffPlanMode')}
                        onTurnOff={() => permission.configure({ planMode: false })}
                    />
                )}
                <AgentChatPermissionMenu
                    canSaveProjectDefault={canSaveProjectDefault}
                    provider={provider}
                    selection={permission}
                    terminalId={terminalId}
                />
                {onTurnOffGoalMode && (
                    <>
                        <Separator
                            className="mx-1 data-[orientation=vertical]:h-4"
                            orientation="vertical"
                        />
                        <AgentChatModeChip
                            icon={Goal}
                            label={t('agentChat.add.goal')}
                            name={t('agentChat.add.goalMode')}
                            turnOffLabel={t('agentChat.add.turnOffGoalMode')}
                            onTurnOff={onTurnOffGoalMode}
                        />
                    </>
                )}
            </div>
            <div className="flex min-w-0 items-center gap-0.5">
                {contextUsage && (
                    <AgentChatContextMeter
                        onCompact={onCompact}
                        // Only Claude Code answers a context composition and keeps a transcript to replay.
                        onShowDetails={
                            canOpenContext && provider === 'claude'
                                ? () => openAgentChatContext(terminalId)
                                : undefined
                        }
                        usage={contextUsage}
                    />
                )}
                <AgentChatModelMenu snapshot={snapshot} terminalId={terminalId} />
            </div>
            {showsStop ? (
                <AgentChatStopButton isStopping={isStopping} onStop={onStop} />
            ) : (
                <AgentChatSendButton
                    isQueueing={isQueueing}
                    isResume={isResume}
                    isSendable={isSendable}
                    keys={sendKeys}
                    sendAction={sendAction}
                    shortcut={sendShortcut}
                    tooltip={sendTooltip}
                />
            )}
        </div>
    );
}
