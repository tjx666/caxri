import { Package } from 'lucide-react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { AgentChatInvocationDetails } from './agent-chat-invocation-chip';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

/**
 * Inline code in a reply that names a skill the Agent can use (`commit`, `$commit`, `/commit`). It keeps the code chip
 * and gains the `$skill` chip's icon; hovering or focusing it opens the skill's instructions, read only while the card
 * is open, with the hover timing of a link card.
 */
export function AgentChatSkillReference({
    className,
    code,
    invocation,
}: {
    className: string;
    code: string;
    invocation: string;
}) {
    const { t } = useTranslation();
    const terminalId = useAgentChatTerminal();
    const label = (
        <>
            <Package
                aria-hidden
                className="mr-0.5 inline-block size-3 align-[-0.1em] text-accent"
            />
            {code}
        </>
    );
    if (!terminalId) return <code className={className}>{label}</code>;
    return (
        <HoverCard>
            <HoverCardTrigger
                closeDelay={120}
                delay={350}
                render={
                    <button
                        aria-label={t('agentChat.slash.showInvocation', { invocation })}
                        className={cn(
                            className,
                            'cursor-default focus-visible:outline focus-visible:outline-accent data-popup-open:text-accent',
                        )}
                        type="button"
                    />
                }
            >
                {label}
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-[28rem] p-0 whitespace-normal">
                <AgentChatInvocationDetails invocation={invocation} terminalId={terminalId} />
            </HoverCardContent>
        </HoverCard>
    );
}
