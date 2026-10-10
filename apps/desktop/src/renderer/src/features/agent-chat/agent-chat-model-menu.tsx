import { useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { findAgentChatModel } from '@caxri/protocol';
import { ChevronDown } from 'lucide-react';

import {
    Menu,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
} from '../../components/ui/menu';
import { configureAgentChat } from './agent-chat-commands';
import { agentChatEffortLabel, agentChatModelLabel } from './agent-chat-presentation';

const LABEL_CLASS_NAME = 'flex min-w-0 items-center gap-1 text-[12px] leading-4 text-muted';

/**
 * The model and reasoning effort the next turn uses, and the menu that switches them, as the Codex app and Claude Code
 * keep beside their input. The menu stays open after a choice so switching the model shows its efforts right away. A
 * provider that listed no models shows the model it reported as plain text.
 */
export function AgentChatModelMenu({
    snapshot,
    terminalId,
}: {
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models'> | undefined;
    terminalId: string;
}) {
    const [isOpen, setOpen] = useState(false);
    const label = agentChatModelLabel(snapshot);
    if (!label) return null;
    const text = (
        <>
            <span className="truncate">{label.model}</span>
            {label.effort && <span className="shrink-0 text-muted">{label.effort}</span>}
        </>
    );
    const models = snapshot?.models;
    if (!models || models.length === 0) return <span className={LABEL_CLASS_NAME}>{text}</span>;
    const current = findAgentChatModel(models, snapshot.model);
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <MenuTrigger
                aria-label={`Model: ${label.model}${label.effort ? `, ${label.effort} effort` : ''}`}
                className={`${LABEL_CLASS_NAME} h-7 shrink cursor-pointer rounded-md border-0 bg-transparent px-1.5 transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground`}
            >
                {text}
                <ChevronDown className="size-3 shrink-0" />
            </MenuTrigger>
            <MenuContent align="end" className="max-w-80 min-w-56" side="top">
                <MenuGroup>
                    <MenuGroupLabel>Model</MenuGroupLabel>
                    <MenuRadioGroup
                        value={current?.id ?? null}
                        onValueChange={(model: string) => configureAgentChat(terminalId, { model })}
                    >
                        {models.map((model) => (
                            <MenuRadioItem key={model.id} value={model.id}>
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate">{model.displayName}</span>
                                    {model.description && (
                                        <span className="truncate text-[11px] leading-4 text-muted">
                                            {model.description}
                                        </span>
                                    )}
                                </span>
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuGroup>
                {current && current.efforts.length > 0 && (
                    <>
                        <MenuSeparator />
                        <MenuGroup>
                            <MenuGroupLabel>Reasoning effort</MenuGroupLabel>
                            <MenuRadioGroup
                                value={snapshot.effort ?? null}
                                onValueChange={(effort: string) =>
                                    configureAgentChat(terminalId, { effort })
                                }
                            >
                                {current.efforts.map((effort) => (
                                    <MenuRadioItem key={effort} value={effort}>
                                        {agentChatEffortLabel(effort)}
                                        {effort === current.defaultEffort && (
                                            <span className="ml-auto pl-3 text-[11px] text-muted">
                                                Default
                                            </span>
                                        )}
                                    </MenuRadioItem>
                                ))}
                            </MenuRadioGroup>
                        </MenuGroup>
                    </>
                )}
            </MenuContent>
        </Menu>
    );
}
