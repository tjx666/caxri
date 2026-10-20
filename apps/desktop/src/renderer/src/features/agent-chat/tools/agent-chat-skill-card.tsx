import { BookOpenText } from 'lucide-react';

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
                        <BookOpenText aria-hidden="true" className="size-5" />
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
 * A skill a sent message asked the Agent to load, as a pill beside its file and folder pills. It only names the skill:
 * the instruction that loads it is the message's own text, kept out of the bubble.
 */
export function AgentChatSkillPill({ name }: { name: string }) {
    const { t } = useTranslation();
    return (
        <li className="min-w-0" data-agent-chat-skill-reference={name}>
            <Tooltip content={t('agentChat.skill.sentTooltip', { name })}>
                <span className="flex h-7 max-w-60 min-w-0 items-center gap-1.5 rounded-full border border-border bg-elevated px-2.5 text-[12px] text-foreground">
                    <BookOpenText aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                    <span className="truncate">{agentChatSkillLabel(name, t)}</span>
                </span>
            </Tooltip>
        </li>
    );
}
