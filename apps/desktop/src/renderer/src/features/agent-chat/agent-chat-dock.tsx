import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentProviderSchema } from '@caxri/protocol';
import { CircleAlert, Info, RotateCcw, Settings2, SquareTerminal, Unplug } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useDialogStore } from '../../stores/dialogs';
import { useTerminal } from '../../stores/selectors';
import type { AgentChatRecoveryNotice } from './transcript/agent-chat-presentation';
import { agentChatRecoveryActions } from './transcript/agent-chat-presentation';
import { AgentChatRequestCard } from './transcript/agent-chat-request-card';

/**
 * Opens Settings at the Chat's Agent Executable row, the target the Terminal recovery bar uses. It resolves the Agent
 * from the Terminal, so it renders nothing for a Terminal that is not a provider's.
 */
function OpenExecutableSettingsButton({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const provider = agentProviderSchema.safeParse(useTerminal(terminalId)?.kind);
    if (!provider.success) return null;
    return (
        <Button
            className="shrink-0 self-center"
            size="sm"
            variant="secondary"
            onClick={() =>
                useDialogStore.getState().openSettings('agent-executable', provider.data)
            }
        >
            <Settings2 className="size-3.5" />
            {t('terminal.recovery.openSettings')}
        </Button>
    );
}

/**
 * Why the Chat cannot continue, with the one action that recovers it. It sits in the dock, outside the scrolling
 * timeline, so reading history never hides the action. Only a `failed` notice reads in the danger tone, as an `alert`;
 * every other kind is a state rather than a fault and takes the neutral border, a `--muted` glyph, and a polite
 * `status`. A hand-over to another client uses the PTY recovery bar's unplugged glyph and Resume; any other neutral
 * kind (a conversation open in another client) uses an info glyph and Retry, which reopens it once the other client
 * lets go. A failure the Chat cannot explain also offers Open as Terminal, where the provider's own output says what
 * went wrong. A missing CLI offers Settings, at the same Executable row the Terminal recovery bar opens, ahead of
 * Retry. It is inset 12px like the composer strip, so the banner, the strip below it, and the composer card step in one
 * rhythm instead of the banner jutting out past the strip to the card's full width.
 */
function AgentChatRecoveryBanner({
    notice,
    terminalId,
    onOpenAsTerminal,
    onRecover,
}: {
    notice: AgentChatRecoveryNotice | undefined;
    terminalId: string;
    onOpenAsTerminal: (() => void) | undefined;
    onRecover: () => void;
}) {
    const { t } = useTranslation();
    if (!notice) return null;
    const actions = agentChatRecoveryActions(notice, Boolean(onOpenAsTerminal));
    const isFailure = notice.kind === 'failed';
    const isDetached = notice.kind === 'detached';
    const Icon = isFailure ? CircleAlert : isDetached ? Unplug : Info;
    return (
        <div
            className={cn(
                'mx-3 flex items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-[12px] leading-5',
                isFailure ? 'border-danger' : 'border-border',
            )}
            data-agent-chat-recovery={notice.kind}
            role={isFailure ? 'alert' : 'status'}
        >
            <Icon
                className={cn('mt-0.5 size-3.5 shrink-0', isFailure ? 'text-danger' : 'text-muted')}
            />
            <div className="min-w-0 flex-1">
                <p className="m-0 text-foreground">{notice.message}</p>
                {notice.detail && <p className="m-0 wrap-anywhere text-muted">{notice.detail}</p>}
            </div>
            {actions.includes('openSettings') && (
                <OpenExecutableSettingsButton terminalId={terminalId} />
            )}
            {actions.includes('openAsTerminal') && onOpenAsTerminal && (
                <Button
                    className="shrink-0 self-center"
                    size="sm"
                    variant="secondary"
                    onClick={onOpenAsTerminal}
                >
                    <SquareTerminal className="size-3.5" />
                    {t('agentChat.dock.openAsTerminal')}
                </Button>
            )}
            <Button
                className="shrink-0 self-center"
                size="sm"
                variant="secondary"
                onClick={onRecover}
            >
                <RotateCcw className="size-3.5" />
                {t(actions.includes('resume') ? 'agentChat.dock.resume' : 'common.retry')}
            </Button>
        </div>
    );
}

/**
 * What docks above the composer, outside the scrolling timeline: the recovery banner and each pending approval or
 * question. The Agent's plan, background work, and queued messages join the composer's strip instead
 * (`AgentChatComposer`).
 */
export function AgentChatDock({
    answeredRequestIds,
    projectRoot,
    providerName,
    recoveryNotice,
    snapshot,
    terminalId,
    onAnswered,
    onOpenAsTerminal,
    onRecover,
}: {
    /**
     * Requests the user answered whose answer the projection has not settled; their cards leave at once.
     */
    answeredRequestIds: ReadonlySet<string>;
    projectRoot: string | undefined;
    providerName: string;
    recoveryNotice: AgentChatRecoveryNotice | undefined;
    snapshot: AgentChatSnapshot | undefined;
    terminalId: string;
    onAnswered: () => void;
    onOpenAsTerminal: (() => void) | undefined;
    onRecover: () => void;
}) {
    return (
        <div className="mx-auto flex max-h-[60%] w-full max-w-3xl shrink-0 flex-col gap-2 overflow-y-auto px-4 empty:hidden">
            <AgentChatRecoveryBanner
                notice={recoveryNotice}
                terminalId={terminalId}
                onOpenAsTerminal={onOpenAsTerminal}
                onRecover={onRecover}
            />
            {snapshot?.requests
                .filter((request) => !answeredRequestIds.has(request.id))
                .map((request) => (
                    <AgentChatRequestCard
                        key={request.id}
                        linkedItem={
                            request.kind === 'question'
                                ? undefined
                                : snapshot.items.find((item) => item.id === request.itemId)
                        }
                        onAnswered={onAnswered}
                        projectRoot={projectRoot}
                        providerName={providerName}
                        request={request}
                        terminalId={terminalId}
                    />
                ))}
        </div>
    );
}
