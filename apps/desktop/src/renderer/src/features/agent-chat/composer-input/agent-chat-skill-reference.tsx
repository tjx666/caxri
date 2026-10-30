import { Package } from 'lucide-react';

import { SharedHoverCard } from '../../../components/ui/hover-card';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { AgentChatInvocationDetails } from '../composer/agent-chat-invocation-chip';
import { AgentChatSkillsContext, useAgentChatSkills } from '../hooks/use-agent-chat-skills';
import { AgentChatTerminalContext, useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';

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
    const skills = useAgentChatSkills();
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
        <SharedHoverCard
            closeDelay={120}
            content={
                // The shared card renders outside this transcript, so the instructions' Markdown gets the Chat's
                // Terminal and skills back here.
                <AgentChatTerminalContext value={terminalId}>
                    <AgentChatSkillsContext value={skills}>
                        <AgentChatInvocationDetails
                            invocation={invocation}
                            terminalId={terminalId}
                        />
                    </AgentChatSkillsContext>
                </AgentChatTerminalContext>
            }
            contentProps={{ align: 'start', className: 'w-[28rem] p-0 whitespace-normal' }}
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
        </SharedHoverCard>
    );
}
