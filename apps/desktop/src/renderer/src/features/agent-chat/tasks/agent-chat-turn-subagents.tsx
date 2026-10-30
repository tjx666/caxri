import { useRef } from 'react';

import { Bot } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../../components/ui/menu';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatTurnSubagent } from './agent-chat-tasks';

const COUNT_CLASS_NAME =
    'min-h-6 shrink-0 gap-1 px-1 text-[11px] text-muted tabular-nums data-popup-open:bg-elevated data-popup-open:text-foreground';

/**
 * How many subagents the turn started, as a Bot glyph and a bare count on the fold row: the glyph already says what is
 * counted, and the names are one hover away. With one subagent the count opens it where the host can open a tab beside
 * the Chat, and elsewhere (Caxri Bot window) expands the fold and scrolls to its row instead, saying so, since nothing
 * opens (issue caxri#1952). With several it lists them to choose from. With neither action it is a plain label. The
 * count sweeps while any of them still runs.
 */
export function AgentChatTurnSubagents({
    onOpen,
    onReveal,
    subagents,
}: {
    onOpen: ((taskId: string) => void) | undefined;
    onReveal: ((itemId: string, element: HTMLElement) => void) | undefined;
    subagents: readonly AgentChatTurnSubagent[];
}) {
    const { t } = useTranslation();
    const trigger = useRef<HTMLButtonElement>(null);
    const names = subagents.map((subagent) => subagent.title ?? t('agentChat.fold.subagent'));
    const isRunning = subagents.some((subagent) => subagent.isRunning);
    const content = (
        <>
            <Bot aria-hidden="true" className="size-3.5 shrink-0" />
            <span className={cn(isRunning && 'activity-shimmer')}>{subagents.length}</span>
        </>
    );
    const summary = t('agentChat.fold.subagents', { count: subagents.length });
    const namesTooltip = (
        <div className="flex flex-col">
            {subagents.map((subagent, index) => (
                <div className="truncate" key={subagent.taskId}>
                    {names[index]}
                </div>
            ))}
        </div>
    );
    if (!onOpen && !onReveal)
        return (
            <Tooltip content={namesTooltip}>
                <span
                    aria-label={`${summary}: ${names.join(', ')}`}
                    className={cn('inline-flex items-center', COUNT_CLASS_NAME)}
                    data-agent-chat-turn-subagents={subagents.length}
                >
                    {content}
                </span>
            </Tooltip>
        );
    const choose = (subagent: AgentChatTurnSubagent, element: HTMLElement) => {
        if (onOpen) onOpen(subagent.taskId);
        else onReveal?.(subagent.itemId, element);
    };
    if (subagents.length === 1) {
        const [only] = subagents;
        const name = names[0] ?? '';
        const label = t(onOpen ? 'agentChat.fold.openSubagent' : 'agentChat.fold.showSubagent', {
            name,
        });
        return (
            <Tooltip content={onOpen ? t('agentChat.timeline.openNamed', { name }) : label}>
                <Button
                    aria-label={label}
                    className={COUNT_CLASS_NAME}
                    data-agent-chat-turn-subagents={1}
                    size="sm"
                    variant="ghost"
                    onClick={(event) => choose(only, event.currentTarget)}
                >
                    {content}
                </Button>
            </Tooltip>
        );
    }
    return (
        <Menu>
            <Tooltip content={namesTooltip}>
                <MenuTrigger
                    aria-label={summary}
                    data-agent-chat-turn-subagents={subagents.length}
                    ref={trigger}
                    render={<Button className={COUNT_CLASS_NAME} size="sm" variant="ghost" />}
                >
                    {content}
                </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" className="max-w-72">
                {subagents.map((subagent, index) => (
                    <MenuItem
                        key={subagent.taskId}
                        onClick={() => {
                            if (trigger.current) choose(subagent, trigger.current);
                        }}
                    >
                        <Bot aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                        <span
                            className={cn(
                                'min-w-0 truncate',
                                subagent.isRunning && 'activity-shimmer',
                            )}
                        >
                            {names[index]}
                        </span>
                    </MenuItem>
                ))}
            </MenuContent>
        </Menu>
    );
}
