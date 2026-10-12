import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { useFocusOnRevision } from '@/hooks/use-focus-on-revision';

import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { agentChatFindCountLabel } from './agent-chat-find';

const ACTION_CLASS_NAME =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-45';

/**
 * The Chat's find bar, at the top right of the conversation like the Terminal's, clear of the message rail on the left
 * and Jump to latest at the bottom. It takes its own strip above the conversation (`AgentChatFindScope`) rather than
 * floating over it, so it never covers the transcript text it searches. Enter and Shift+Enter step through matches, and
 * Escape closes and returns to the composer; the buttons' tooltips name those keys.
 */
export function AgentChatFindBar({
    activeIndex,
    count,
    focusRevision,
    query,
    onClose,
    onNext,
    onPrevious,
    onQueryChange,
}: {
    activeIndex: number;
    count: number;
    focusRevision: number;
    query: string;
    onClose: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onQueryChange: (query: string) => void;
}) {
    const inputReference = useRef<HTMLInputElement>(null);
    useFocusOnRevision(focusRevision, inputReference, { select: true });
    const label = agentChatFindCountLabel(query, count, activeIndex);
    const hasNoMatch = query !== '' && count === 0;
    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (event.shiftKey) onPrevious();
        else onNext();
    };
    return (
        <div className="flex shrink-0 justify-end px-2 pt-2">
            <search
                aria-label="Find in Chat"
                className="flex max-w-full items-center gap-1 rounded border border-border bg-surface p-1"
                data-agent-chat-find=""
            >
                <InputGroup appearance="workbench" className="w-56" size="dense">
                    <Input
                        ref={inputReference}
                        appearance="embedded"
                        aria-label="Find in Chat"
                        className="flex-1 text-foreground"
                        placeholder="Find"
                        size="dense"
                        spellCheck={false}
                        value={query}
                        onChange={(event) => onQueryChange(event.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                    />
                </InputGroup>
                <span
                    aria-live="polite"
                    className={cn(
                        'min-w-10 text-center text-[11px] tabular-nums',
                        hasNoMatch ? 'text-danger' : 'text-muted',
                    )}
                >
                    {label}
                </span>
                <Tooltip content="Previous Match" shortcut="shift+enter">
                    <button
                        aria-label="Previous match"
                        className={ACTION_CLASS_NAME}
                        disabled={count === 0}
                        type="button"
                        onClick={onPrevious}
                    >
                        <ChevronUp size={14} />
                    </button>
                </Tooltip>
                <Tooltip content="Next Match" shortcut="enter">
                    <button
                        aria-label="Next match"
                        className={ACTION_CLASS_NAME}
                        disabled={count === 0}
                        type="button"
                        onClick={onNext}
                    >
                        <ChevronDown size={14} />
                    </button>
                </Tooltip>
                <Tooltip content="Close Find" shortcut="escape">
                    <button
                        aria-label="Close find"
                        className={ACTION_CLASS_NAME}
                        type="button"
                        onClick={onClose}
                    >
                        <X size={14} />
                    </button>
                </Tooltip>
            </search>
        </div>
    );
}
