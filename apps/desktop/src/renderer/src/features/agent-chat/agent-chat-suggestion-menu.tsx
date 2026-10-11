import { cn } from '../../lib/utilities';
import type { AgentChatSuggestion } from './agent-chat-suggestions';
import { agentChatSuggestionOptionId } from './agent-chat-suggestions';

/**
 * Suggestions above the composer: the slash-command and skill list, and the `@` Sessions list. Focus stays in the
 * input, which drives the list through `aria-activedescendant`; the pointer can pick a row too. Rows match the command
 * palette's density and focus fill.
 */
function SuggestionList({
    activeIndex,
    heading,
    label,
    listId,
    onChoose,
    onHover,
    suggestions,
}: {
    activeIndex: number;
    /**
     * Visible group title, for a list whose rows do not say what they are on their own.
     */
    heading?: string;
    label: string;
    listId: string;
    onChoose: (index: number) => void;
    onHover: (index: number) => void;
    suggestions: readonly AgentChatSuggestion[];
}) {
    return (
        <div
            aria-label={label}
            className="absolute inset-x-0 bottom-full mb-1 max-h-64 overflow-y-auto rounded-md bg-elevated p-1 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]"
            id={listId}
            role="listbox"
        >
            {heading && (
                <div
                    aria-hidden="true"
                    className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted"
                >
                    {heading}
                </div>
            )}
            {suggestions.map((suggestion, index) => (
                <div
                    aria-selected={index === activeIndex}
                    className={cn(
                        'flex min-h-7 cursor-pointer items-baseline gap-2 rounded px-2 py-1',
                        index === activeIndex &&
                            'bg-list-focus-background text-list-focus-foreground',
                    )}
                    id={agentChatSuggestionOptionId(listId, suggestion.key)}
                    key={suggestion.key}
                    role="option"
                    // Keeps focus in the input; the click below chooses the row.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onChoose(index)}
                    onMouseMove={() => onHover(index)}
                >
                    <span
                        className={cn(
                            'shrink-0',
                            suggestion.isLabelLiteral ? 'font-mono' : 'max-w-[60%] truncate',
                        )}
                    >
                        {suggestion.label}
                    </span>
                    {suggestion.hint && (
                        <span className="shrink-0 text-muted">{suggestion.hint}</span>
                    )}
                    {suggestion.description && (
                        <span className="min-w-0 truncate text-muted">
                            {suggestion.description}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

interface SuggestionMenuState {
    activeIndex: number;
    highlight: (index: number) => void;
    isOpen: boolean;
    listId: string;
    suggestions: readonly AgentChatSuggestion[];
}

/**
 * The composer's two lists, of which at most one shows: the slash-command list wins while open, otherwise the `@`
 * Sessions list.
 */
export function AgentChatSuggestionMenu({
    commandMenu,
    onChooseCommand,
    sessionMenu,
}: {
    commandMenu: SuggestionMenuState;
    onChooseCommand: (index: number) => void;
    sessionMenu: SuggestionMenuState & { chooseAt: (index: number) => void };
}) {
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                label="Commands and skills"
                listId={commandMenu.listId}
                suggestions={commandMenu.suggestions}
                onChoose={onChooseCommand}
                onHover={commandMenu.highlight}
            />
        );
    if (!sessionMenu.isOpen) return null;
    return (
        <SuggestionList
            activeIndex={sessionMenu.activeIndex}
            heading="Sessions"
            label="Sessions"
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
