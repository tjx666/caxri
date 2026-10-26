import { useState } from 'react';

import type { AgentChatContinuation, AgentProvider } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../../components/ui/menu';
import { Spinner } from '../../../components/ui/spinner';
import {
    SplitButton,
    SplitButtonAction,
    SplitButtonTrigger,
} from '../../../components/ui/split-button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { useCaxriQuery } from '../../../queries/client';
import { useSessions } from '../../../stores/selectors';
import { openSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { useClockTick } from '../hooks/use-clock-tick';
import {
    agentChatContinuationChoice,
    agentChatContinuationUnavailableLabel,
} from './agent-chat-continuation';
import { continueAgentChatInAgent } from './agent-chat-usage-limit-commands';
import { useCanContinueInAgent } from './use-can-continue-in-agent';

const LINK_CLASS =
    'min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent';

/**
 * Where another Agent already continued this work: a link to that Session, like the `/new-session` bubble's "Continued
 * in" row. A Session the Workbench no longer lists reads as its Agent's name.
 */
function ContinuedInRow({ continuedIn }: { continuedIn: AgentChatContinuation }) {
    const { t } = useTranslation();
    const session = useSessions()?.find(({ id }) => id === continuedIn.sessionId);
    const title = session
        ? sessionTitleForDisplay(session.displayTitle, t)
        : resolveAgentIcon(continuedIn.provider).label;
    return (
        <div
            className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4"
            data-agent-chat-continued-in={continuedIn.sessionId}
        >
            <span className="flex-none text-muted">{t('agentChat.handoff.continuedIn')}</span>
            <AgentIdentityIcon identity={continuedIn.provider} size={12} />
            {session && session.archivedAt === undefined ? (
                <button
                    className={LINK_CLASS}
                    type="button"
                    onClick={() => openSession(session.id)}
                >
                    {title}
                </button>
            ) : (
                <span className="min-w-0 truncate">{title}</span>
            )}
        </div>
    );
}

/**
 * Continues this Chat's work in a new Session with another Agent (`agentChat.continueInAgent`): a split button whose
 * leading half names the first Agent that can take over, and whose list shows every other Agent, the unavailable ones
 * disabled with why. Server Core resolves the same failed turn (`turnId`) or guard window to the same Session, so a
 * double click opens it instead of creating a second one. Once continued, the control becomes a link to that Session. A
 * window without a Workbench (the Agent Commander) cannot show the new Session, so it offers none of this.
 */
export function AgentChatContinueInAgent({
    continuedIn,
    label = 'continueIn',
    terminalId,
    turnId,
}: {
    continuedIn: AgentChatContinuation | undefined;
    /**
     * `continueIn` for a failed turn ("Continue in Codex"); `openElsewhere` for the usage guard's "Open in another
     * Agent", which keeps its own wording beside Generate hand-off.
     */
    label?: 'continueIn' | 'openElsewhere';
    terminalId: string;
    turnId: string | undefined;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const [pending, setPending] = useState<AgentProvider>();
    const canContinue = useCanContinueInAgent();
    const query = useCaxriQuery(
        'agentChat.continuationTargets',
        { terminalId },
        { enabled: canContinue && continuedIn === undefined, staleTime: 30_000 },
    );
    if (!canContinue) return null;
    if (continuedIn) return <ContinuedInRow continuedIn={continuedIn} />;
    const { primary, targets } = agentChatContinuationChoice(query.data?.targets ?? []);
    const run = (provider: AgentProvider): void => {
        if (pending) return;
        setPending(provider);
        void continueAgentChatInAgent(terminalId, provider, turnId).finally(() =>
            setPending(undefined),
        );
    };
    const primaryName = primary ? resolveAgentIcon(primary).label : undefined;
    const actionText =
        label === 'openElsewhere'
            ? t('agentChat.usageGuard.openElsewhere')
            : primaryName
              ? t('agentChat.usageLimit.continueIn', { provider: primaryName })
              : t('agentChat.usageLimit.continueElsewhere');
    const menu = (
        <MenuContent align="end">
            {targets.map((target) => {
                const reason = agentChatContinuationUnavailableLabel(target, now, t);
                return (
                    <MenuItem
                        disabled={reason !== undefined}
                        key={target.provider}
                        onClick={() => run(target.provider)}
                    >
                        <AgentIdentityIcon identity={target.provider} size={14} />
                        <span className="flex-1 truncate">
                            {resolveAgentIcon(target.provider).label}
                        </span>
                        {reason && <span className="text-[11px] text-muted">{reason}</span>}
                    </MenuItem>
                );
            })}
        </MenuContent>
    );
    if (!primary || label === 'openElsewhere')
        return (
            <Menu>
                <MenuTrigger
                    render={
                        <Button
                            aria-disabled={pending !== undefined || undefined}
                            className="min-h-6 gap-1.5 px-2 text-[12px]"
                            data-agent-chat-continue=""
                            size="sm"
                            variant="secondary"
                        >
                            {pending && <Spinner className="size-3.5" role="presentation" />}
                            {primary || query.isPending
                                ? actionText
                                : t('agentChat.usageLimit.noTarget')}
                        </Button>
                    }
                />
                {menu}
            </Menu>
        );
    return (
        <SplitButton>
            <Tooltip
                content={t('agentChat.usageLimit.continueTooltip', {
                    provider: resolveAgentIcon(primary).label,
                })}
            >
                <SplitButtonAction
                    aria-disabled={pending !== undefined || undefined}
                    className="min-h-6 gap-1.5 px-2 text-[12px]"
                    data-agent-chat-continue={primary}
                    size="sm"
                    variant="secondary"
                    onClick={() => run(primary)}
                >
                    {pending ? (
                        <Spinner className="size-3.5" role="presentation" />
                    ) : (
                        <AgentIdentityIcon identity={primary} size={14} />
                    )}
                    {actionText}
                </SplitButtonAction>
            </Tooltip>
            <Menu>
                <MenuTrigger
                    render={
                        <SplitButtonTrigger
                            aria-label={t('agentChat.usageLimit.chooseAgent')}
                            className="min-h-6"
                            variant="secondary"
                        />
                    }
                />
                {menu}
            </Menu>
        </SplitButton>
    );
}
