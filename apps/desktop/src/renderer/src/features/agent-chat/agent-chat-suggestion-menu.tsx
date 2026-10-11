import type { AgentAction } from '@caxri/protocol';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import { agentChatMenuGroupHeading } from './agent-chat-slash-commands';
import type { AgentChatSuggestion } from './agent-chat-suggestions';
import { agentChatSuggestionOptionId } from './agent-chat-suggestions';

const GROUP_HEADING_CLASS_NAME = 'px-2 pt-1.5 pb-0.5 text-[11px] leading-4 text-muted';

/**
 * Suggestions above the composer: the slash-command and skill list, and the `@` Sessions list. Focus stays in the
 * input, which drives the list through `aria-activedescendant`; the pointer can pick a row too. Rows match the command
 * palette's density and focus fill, under group headings, and a `meta` footer names the keys. A list with an
 * `emptyText` stays open on no match so a typo reads as a miss, and `notice` explains rows that are still missing.
 *
 * It is not a Base UI popup, because focus has to stay in the textarea while the arrow keys drive it, but it wears the
 * shared overlay surface (`--elevated`, the `--border` ring plus `--shadow` elevation the popover and tooltip use) and
 * enters with the overlay layer's fade and zoom on `--motion-overlay-enter`. It unmounts instantly, like the
 * autocomplete it is: the next keystroke must not wait on an exit animation.
 */
function SuggestionList({
    activeIndex,
    emptyText,
    footer,
    headingAt,
    label,
    listId,
    notice,
    onChoose,
    onHover,
    suggestions,
}: {
    activeIndex: number;
    emptyText?: string;
    footer: string;
    /**
     * The visible group title a row starts, or `undefined` when it continues the group above it.
     */
    headingAt: (index: number) => string | undefined;
    label: string;
    listId: string;
    notice?: { text: string; isLoading: boolean };
    onChoose: (index: number) => void;
    onHover: (index: number) => void;
    suggestions: readonly AgentChatSuggestion[];
}) {
    return (
        <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 absolute inset-x-0 bottom-full mb-1 flex max-h-72 origin-bottom flex-col overflow-hidden rounded-md bg-elevated text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] duration-(--motion-overlay-enter) ease-(--motion-ease-enter)">
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
                <div aria-label={label} id={listId} role="listbox">
                    {suggestions.map((suggestion, index) => {
                        const heading = headingAt(index);
                        return (
                            <div key={suggestion.key} role="presentation">
                                {heading && (
                                    <div className={GROUP_HEADING_CLASS_NAME} role="presentation">
                                        {heading}
                                    </div>
                                )}
                                <div
                                    aria-selected={index === activeIndex}
                                    className={cn(
                                        'flex min-h-7 cursor-pointer items-baseline gap-2 rounded px-2 py-1',
                                        index === activeIndex &&
                                            'bg-list-focus-background text-list-focus-foreground',
                                    )}
                                    id={agentChatSuggestionOptionId(listId, suggestion.key)}
                                    role="option"
                                    // Keeps focus in the input; the click below chooses the row.
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => onChoose(index)}
                                    onMouseMove={() => onHover(index)}
                                >
                                    <span
                                        className={cn(
                                            'shrink-0',
                                            suggestion.isLabelLiteral
                                                ? 'font-mono'
                                                : 'max-w-[60%] truncate',
                                        )}
                                    >
                                        {suggestion.label}
                                    </span>
                                    {suggestion.hint && (
                                        <span className="shrink-0 text-muted">
                                            {suggestion.hint}
                                        </span>
                                    )}
                                    {suggestion.description && (
                                        <span className="min-w-0 truncate text-muted">
                                            {suggestion.description}
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                {suggestions.length === 0 && emptyText && (
                    <div className="flex min-h-7 items-center px-2 py-1 text-muted" role="status">
                        {emptyText}
                    </div>
                )}
                {notice && (
                    <div className="flex min-h-7 items-center gap-2 px-2 py-1 text-muted">
                        {notice.isLoading && (
                            <Spinner
                                aria-hidden
                                className="size-3.5 shrink-0"
                                role="presentation"
                            />
                        )}
                        {notice.text}
                    </div>
                )}
            </div>
            <div
                aria-hidden
                className="shrink-0 border-0 border-t border-solid border-border px-3 py-1 text-[11px] leading-4 text-muted"
            >
                {footer}
            </div>
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
    commandMenu: SuggestionMenuState & {
        matches: readonly AgentAction[];
        skillNotice: { text: string; isLoading: boolean } | undefined;
    };
    onChooseCommand: (index: number) => void;
    sessionMenu: SuggestionMenuState & { chooseAt: (index: number) => void };
}) {
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                emptyText="No matching command or skill"
                footer="↑↓ to move · Tab to complete · Enter to run"
                headingAt={(index) => agentChatMenuGroupHeading(commandMenu.matches, index)}
                label="Commands and skills"
                listId={commandMenu.listId}
                notice={commandMenu.skillNotice}
                suggestions={commandMenu.suggestions}
                onChoose={onChooseCommand}
                onHover={commandMenu.highlight}
            />
        );
    if (!sessionMenu.isOpen) return null;
    return (
        <SuggestionList
            activeIndex={sessionMenu.activeIndex}
            footer="↑↓ to move · Enter to cite"
            headingAt={(index) => (index === 0 ? 'Sessions' : undefined)}
            label="Sessions"
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
