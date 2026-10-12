/**
 * One row of an input-driven suggestion list (`SuggestionList`). `label` is set in the monospace face when it is
 * something the user types verbatim (a `/command`), and in the UI face when it is a name (a Session or Inbox item
 * title).
 */
export interface SuggestionOption {
    description?: string;
    hint?: string;
    isLabelLiteral: boolean;
    /**
     * Unique within the list; also the suffix of the row's DOM id.
     */
    key: string;
    label: string;
}

/**
 * DOM id of a suggestion row, for the input's `aria-activedescendant`.
 */
export function suggestionOptionId(listId: string, key: string): string {
    return `${listId}-${key}`;
}

/**
 * Where an `@` mention being typed sits in a text: `start` is the index of the `@`, `end` the caret, and `query` what
 * was typed after the `@`.
 */
export interface CaretMention {
    end: number;
    query: string;
    start: number;
}

/**
 * The `@` mention being typed at the caret: the whitespace-delimited word that ends at the caret and starts with `@`,
 * so the `@` must open the text or follow whitespace. `start`/`end` cover the whole word so choosing a row replaces
 * exactly what was typed. A second `@` inside the word (an email address) is not a mention.
 */
export function mentionAtCaret(text: string, caret: number): CaretMention | undefined {
    const before = text.slice(0, caret);
    const start = before.search(/\S*$/u);
    const word = before.slice(start);
    if (!word.startsWith('@') || word.includes('@', 1)) return undefined;
    return { end: caret, query: word.slice(1), start };
}

export type SuggestionMenuKeyAction = 'choose' | 'complete' | 'dismiss' | 'next' | 'previous';

/**
 * What a key does while the suggestion list is open. Tab completes the active row into the input without running it,
 * the way a shell completes a name; Enter chooses it, which runs a command that takes no arguments. Anything else is
 * the input's own key.
 */
export function suggestionMenuKeyAction(event: {
    key: string;
    shiftKey: boolean;
}): SuggestionMenuKeyAction | undefined {
    switch (event.key) {
        case 'ArrowDown': {
            return 'next';
        }
        case 'ArrowUp': {
            return 'previous';
        }
        case 'Escape': {
            return 'dismiss';
        }
        case 'Tab': {
            return 'complete';
        }
        case 'Enter': {
            return event.shiftKey ? undefined : 'choose';
        }
        default: {
            return undefined;
        }
    }
}
