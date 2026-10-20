import type { AgentChatComposerKey } from './agent-chat-composer-keys';

/**
 * A Markdown list item's leading marker: indent, then a bullet (`-`, `*`, `+`) or a number with `.` or `)`, the spaces
 * after it, and an optional task box. Numbers stop at nine digits so `Number` stays exact.
 */
const LIST_ITEM =
    /^(?<indent> *)(?:(?<bullet>[-*+])|(?<number>\d{1,9})(?<delimiter>[.)]))(?<gap> +)(?<task>\[[ x]\] +)?/i;

/**
 * `LIST_ITEM`'s groups; the alternatives and the task box leave some unmatched, which the DOM types do not express.
 */
interface ListItemGroups {
    bullet?: string;
    delimiter?: string;
    gap: string;
    indent: string;
    number?: string;
    task?: string;
}

function listItem(line: string): { groups: ListItemGroups; length: number } | undefined {
    const match = LIST_ITEM.exec(line);
    return match
        ? { groups: match.groups as unknown as ListItemGroups, length: match[0].length }
        : undefined;
}

/**
 * One replacement in the composer's text: `text` replaces `from..to`, then the caret sits at `caret`.
 */
export interface AgentChatTextEdit {
    caret: number;
    from: number;
    text: string;
    to: number;
}

/**
 * Whether a composer key is Shift+Enter, the newline key, which continues a list instead when the caret is in one.
 */
export function isAgentChatListContinuationKey(key: AgentChatComposerKey): boolean {
    return (
        key.key === 'Enter' &&
        key.shiftKey &&
        !key.altKey &&
        !key.ctrlKey &&
        !key.metaKey &&
        !key.isComposing
    );
}

/**
 * What Shift+Enter does on a Markdown list line, as in the Codex app's composer (Enter still sends): the newline starts
 * the next item with the same indent and marker (`2.` after `1.`, `- [ ]` after a task), carrying the text after the
 * caret into it, and renumbers the ordered items below. On an item with no text it ends the list by clearing the
 * marker. `undefined` leaves the key to the textarea: no list line, a selection across lines, or a caret inside the
 * marker.
 */
export function agentChatListContinuation(
    value: string,
    selectionStart: number,
    selectionEnd: number,
): AgentChatTextEdit | undefined {
    if (value.slice(selectionStart, selectionEnd).includes('\n')) return undefined;
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBreak = value.indexOf('\n', selectionEnd);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    const line = value.slice(lineStart, lineEnd);
    const item = listItem(line);
    if (!item || selectionStart < lineStart + item.length) return undefined;
    if (line.slice(item.length).trim() === '')
        return { caret: lineStart, from: lineStart, text: '', to: lineEnd };

    const { indent, bullet, number, delimiter = '.', gap, task } = item.groups;
    const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
    const insertion = `\n${indent}${marker}${gap}${task ? '[ ] ' : ''}`;
    const continued = { caret: selectionStart + insertion.length, from: selectionStart };
    if (number === undefined) return { ...continued, text: insertion, to: selectionEnd };

    const below = renumberedItems(value, lineEnd, indent, delimiter, Number(number) + 2);
    if (!below) return { ...continued, text: insertion, to: selectionEnd };
    return {
        ...continued,
        text: insertion + value.slice(selectionEnd, lineEnd) + below.text,
        to: below.end,
    };
}

/**
 * The ordered items right after `from` at the same indent and delimiter, renumbered from `next`, skipping their deeper
 * nested lines; `undefined` when no number changes. Stops at the first line that is not part of the list.
 */
function renumberedItems(
    value: string,
    from: number,
    indent: string,
    delimiter: string,
    next: number,
): { end: number; text: string } | undefined {
    let text = '';
    let end = from;
    let number = next;
    let isChanged = false;
    while (end < value.length) {
        const lineBreak = value.indexOf('\n', end + 1);
        const lineEnd = lineBreak === -1 ? value.length : lineBreak;
        const line = value.slice(end + 1, lineEnd);
        const item = listItem(line)?.groups;
        const isNested = line.startsWith(`${indent} `) && line.trim() !== '';
        if (item?.indent === indent && item.number !== undefined && item.delimiter === delimiter) {
            const renumbered = `${indent}${number}${line.slice(indent.length + item.number.length)}`;
            isChanged ||= renumbered !== line;
            text += `\n${renumbered}`;
            number += 1;
        } else if (isNested) text += `\n${line}`;
        else break;
        end = lineEnd;
    }
    return isChanged ? { end, text } : undefined;
}
