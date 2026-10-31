import { useState } from 'react';

import type { BotAgent } from '@caxri/protocol';
import { botAgentIds } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { botAgentName } from './bot-data-commands';

/**
 * Shown instead of Caxri Bot's Terminal the first time the window opens. Caxri Bot keeps running after its window
 * closes and its Agents work with full access, so it states what will run and how, and starts only on the user's
 * click.
 */
export function BotStartPrompt({
    agent: storedAgent,
    onStart,
}: {
    agent: BotAgent;
    onStart: (agent: BotAgent) => void;
}) {
    const { t } = useTranslation();
    const [agent, setAgent] = useState(storedAgent);
    const facts = [
        { label: t('caxriBot.start.permissionsLabel'), text: t('caxriBot.start.permissions') },
        { label: t('caxriBot.start.surfaceLabel'), text: t('caxriBot.start.surface') },
        { label: t('caxriBot.start.backgroundLabel'), text: t('caxriBot.start.background') },
    ];
    return (
        <section
            aria-labelledby="bot-start-title"
            className="bot-start-prompt flex h-full items-center justify-center overflow-auto p-6"
        >
            <div className="flex w-full max-w-[460px] flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <h2 id="bot-start-title" className="m-0 text-[15px] font-semibold">
                        {t('caxriBot.start.title')}
                    </h2>
                    <p className="m-0 text-[13px] text-muted">{t('caxriBot.start.description')}</p>
                </div>
                <dl className="m-0 grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-3 text-[13px]">
                    <dt className="text-muted">{t('caxriBot.start.agentLabel')}</dt>
                    <dd className="m-0">
                        <ToggleGroup
                            aria-label={t('caxriBot.start.agentLabel')}
                            value={[agent]}
                            onValueChange={(next: BotAgent[]) => {
                                if (next[0]) setAgent(next[0]);
                            }}
                        >
                            {botAgentIds.map((id) => (
                                <ToggleGroupItem key={id} value={id} className="gap-1.5">
                                    <AgentIdentityIcon identity={id} size={14} />
                                    {botAgentName(id)}
                                </ToggleGroupItem>
                            ))}
                        </ToggleGroup>
                    </dd>
                    {facts.map((fact) => (
                        <div key={fact.label} className="contents">
                            <dt className="text-muted">{fact.label}</dt>
                            <dd className="m-0">{fact.text}</dd>
                        </div>
                    ))}
                </dl>
                <div>
                    <Button onClick={() => onStart(agent)}>{t('caxriBot.start.action')}</Button>
                </div>
            </div>
        </section>
    );
}
