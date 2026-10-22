import { Package } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { AgentChatAttachmentRemoveButton } from '../attachments/agent-chat-path-attachment-card';
import { agentChatSkillLabel } from '../transcript/agent-chat-presentation';

/**
 * A skill attached to the message being written, laid out like a file card: an icon tile, the skill's name, and
 * "Skill", with what sending it does on hover. The message asks the Agent to load the skill when sent.
 */
export function AgentChatSkillCard({ name, onRemove }: { name: string; onRemove: () => void }) {
    const { t } = useTranslation();
    const label = agentChatSkillLabel(name, t);
    return (
        <li className="relative" data-agent-chat-skill-attachment={name}>
            <Tooltip content={t('agentChat.skill.tooltip', { name })}>
                <div className="flex h-14 max-w-60 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-elevated pr-4 pl-2">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                        <Package aria-hidden="true" className="size-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] leading-5 font-medium text-foreground">
                            {label}
                        </span>
                        <span className="text-[12px] leading-4 text-muted">
                            {t('agentChat.skill.kind')}
                        </span>
                    </span>
                </div>
            </Tooltip>
            <AgentChatAttachmentRemoveButton
                className="-top-1.5 -right-1.5"
                label={t('agentChat.attachments.remove', { name: label })}
                onRemove={onRemove}
            />
        </li>
    );
}

/**
 * A skill a sent message asked the Agent to load, as an inline chip at the start of its bubble, styled like the
 * `$skill` invocation chip (`AgentChatInvocationChip`) so the skill and the words read as one message. It only names
 * the skill: the instruction that loads it is the message's own text, kept out of the bubble. `align-top` for the same
 * reason as the invocation chip: an inline flex box takes its baseline from the icon and would lift above the words.
 */
export function AgentChatSkillPill({ name }: { name: string }) {
    const { t } = useTranslation();
    return (
        <Tooltip content={t('agentChat.skill.sentTooltip', { name })}>
            <span
                className="mr-1 inline-flex max-w-full items-center gap-1 rounded-md bg-accent/15 px-1.5 align-top font-medium text-accent"
                data-agent-chat-skill-reference={name}
            >
                <Package aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{agentChatSkillLabel(name, t)}</span>
            </span>
        </Tooltip>
    );
}
