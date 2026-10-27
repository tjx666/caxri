import type { BotAgent } from '@caxri/protocol';
import { botAgentIds } from '@caxri/protocol';
import { ChevronDown } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Menu,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuTrigger,
} from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { botAgentName, switchBotAgent } from './bot-data-commands';

/**
 * Which Agent CLI Caxri Bot runs, beside the title it qualifies, and the place to change it. Picking the other Agent
 * asks first, because Caxri Bot starts a new conversation on it.
 */
export function BotAgentMenu({ agent }: { agent: BotAgent }) {
    const { t } = useTranslation();
    const name = botAgentName(agent);
    return (
        <Menu>
            <Tooltip content={t('caxriBot.agent.tooltip', { agent: name })}>
                <MenuTrigger
                    render={
                        <Button
                            aria-label={t('caxriBot.agent.label', { agent: name })}
                            className="caxri-bot-agent gap-1.5 px-1.5 text-muted"
                            size="sm"
                            variant="ghost"
                        >
                            <AgentIdentityIcon identity={agent} size={13} />
                            {name}
                            <ChevronDown aria-hidden="true" size={12} />
                        </Button>
                    }
                />
            </Tooltip>
            <MenuContent className="min-w-56">
                <MenuGroup>
                    <MenuGroupLabel>{t('caxriBot.agent.menuLabel')}</MenuGroupLabel>
                    <MenuRadioGroup
                        value={agent}
                        onValueChange={(next: BotAgent) => {
                            void switchBotAgent(agent, next);
                        }}
                    >
                        {botAgentIds.map((id) => (
                            <MenuRadioItem key={id} value={id} closeOnClick>
                                <AgentIdentityIcon identity={id} size={14} />
                                {botAgentName(id)}
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuGroup>
            </MenuContent>
        </Menu>
    );
}
