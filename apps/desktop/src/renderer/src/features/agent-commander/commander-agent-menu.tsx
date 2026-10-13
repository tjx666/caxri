import type { CommanderAgent } from '@caxri/protocol';
import { commanderAgentIds } from '@caxri/protocol';
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
import { commanderAgentName, switchCommanderAgent } from './commander-data-commands';

/**
 * Which Agent CLI the Commander runs, beside the title it qualifies, and the place to change it. Picking the other
 * Agent asks first, because the Commander starts a new conversation on it.
 */
export function CommanderAgentMenu({ agent }: { agent: CommanderAgent }) {
    const { t } = useTranslation();
    const name = commanderAgentName(agent);
    return (
        <Menu>
            <Tooltip content={t('agentCommander.agent.tooltip', { agent: name })}>
                <MenuTrigger
                    render={
                        <Button
                            aria-label={t('agentCommander.agent.label', { agent: name })}
                            className="agent-commander-agent gap-1.5 px-1.5 text-muted"
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
                    <MenuGroupLabel>{t('agentCommander.agent.menuLabel')}</MenuGroupLabel>
                    <MenuRadioGroup
                        value={agent}
                        onValueChange={(next: CommanderAgent) => {
                            // eslint-disable-next-line no-void -- the switch reports its own failure through a toast
                            void switchCommanderAgent(agent, next);
                        }}
                    >
                        {commanderAgentIds.map((id) => (
                            <MenuRadioItem key={id} value={id} closeOnClick>
                                <AgentIdentityIcon identity={id} size={14} />
                                {commanderAgentName(id)}
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuGroup>
            </MenuContent>
        </Menu>
    );
}
