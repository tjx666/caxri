import type { AgentAction } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { agentChatCommandOptionId } from './agent-chat-slash-commands';

/**
 * Command and skill suggestions above the composer. Focus stays in the input, which drives the list through
 * `aria-activedescendant`; the pointer can pick a row too. Rows match the command palette's density and focus fill.
 */
export function AgentChatCommandMenu({
    activeIndex,
    commands,
    listId,
    onChoose,
    onHover,
}: {
    activeIndex: number;
    commands: readonly AgentAction[];
    listId: string;
    onChoose: (action: AgentAction) => void;
    onHover: (index: number) => void;
}) {
    return (
        <div
            aria-label="Commands and skills"
            className="absolute inset-x-0 bottom-full mb-1 max-h-64 overflow-y-auto rounded-md bg-elevated p-1 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]"
            id={listId}
            role="listbox"
        >
            {commands.map((command, index) => (
                <div
                    aria-selected={index === activeIndex}
                    className={cn(
                        'flex min-h-7 cursor-pointer items-baseline gap-2 rounded px-2 py-1',
                        index === activeIndex &&
                            'bg-list-focus-background text-list-focus-foreground',
                    )}
                    id={agentChatCommandOptionId(listId, command.invocation)}
                    key={command.invocation}
                    role="option"
                    // Keeps focus in the input; the click below chooses the row.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onChoose(command)}
                    onMouseMove={() => onHover(index)}
                >
                    <span className="shrink-0 font-mono">{command.invocation}</span>
                    {command.argumentHint && (
                        <span className="shrink-0 text-muted">{command.argumentHint}</span>
                    )}
                    {command.description && (
                        <span className="min-w-0 truncate text-muted">{command.description}</span>
                    )}
                </div>
            ))}
        </div>
    );
}
