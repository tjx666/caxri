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
 * marker. `undefined` leaves the key to the editor: no list line, a selection across lines, or a caret inside the
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

/**
 * Whether a composer key is Tab or Shift+Tab without other modifiers, outside IME composition: the keys that indent and
 * outdent the draft's lines once it holds text (`agentChatIndentation`).
 */
export function isAgentChatIndentKey(key: AgentChatComposerKey): boolean {
    return key.key === 'Tab' && !key.altKey && !key.ctrlKey && !key.metaKey && !key.isComposing;
}

/**
 * How far Tab and Shift+Tab move a line that is not a list item.
 */
const PLAIN_INDENT = 2;

function leadingSpaces(line: string): number {
    return line.length - line.trimStart().length;
}

/**
 * How far Tab (or Shift+Tab, with `isOutdent`) moves the lines from `lineStart` on: a list item nests under the item
 * above it, so it moves to that item's text column (3 after `1. `, 2 after `- `), and back out to its parent's indent.
 * Anything else moves by two spaces.
 */
function indentationStep(value: string, lineStart: number, isOutdent: boolean): number {
    const lineBreak = value.indexOf('\n', lineStart);
    const line = value.slice(lineStart, lineBreak === -1 ? value.length : lineBreak);
    const item = listItem(line);
    const indent = leadingSpaces(line);
    if (!item) return isOutdent ? Math.min(indent, PLAIN_INDENT) : PLAIN_INDENT;
    const above =
        lineStart === 0
            ? []
            : value
                  .slice(0, lineStart - 1)
                  .split('\n')
                  .toReversed();
    for (const previous of above) {
        const previousItem = listItem(previous);
        if (!previousItem) continue;
        const previousIndent = previousItem.groups.indent.length;
        // A parent above with no sibling between: the item is its first child.
        if (previousIndent < indent) return isOutdent ? indent - previousIndent : markerWidth(item);
        if (!isOutdent && previousIndent === indent) return markerWidth(previousItem);
    }
    return isOutdent ? indent : markerWidth(item);
}

/**
 * The width of an item's marker and the spaces after it, without its indent or task box: where its text starts.
 */
function markerWidth(item: { groups: ListItemGroups; length: number }): number {
    return item.length - item.groups.indent.length - (item.groups.task?.length ?? 0);
}

/**
 * What Tab and Shift+Tab do in a composer that holds text, instead of moving focus out of it: on a list line, or across
 * a selection of several lines, Tab indents every touched line (a list item nests under the one above) and Shift+Tab
 * outdents them; on any other line Tab types two spaces at the caret and Shift+Tab removes up to two leading spaces.
 * Blank lines stay empty. `undefined` when nothing changes, such as Shift+Tab on an unindented line.
 */
export function agentChatIndentation(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    isOutdent: boolean,
): AgentChatTextEdit | undefined {
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBreak = value.indexOf('\n', selectionEnd);
    const blockEnd = lineBreak === -1 ? value.length : lineBreak;
    const lines = value.slice(lineStart, blockEnd).split('\n');
    if (!isOutdent && lines.length === 1 && !listItem(lines[0])) {
        const text = ' '.repeat(PLAIN_INDENT);
        return {
            caret: selectionStart + text.length,
            from: selectionStart,
            text,
            to: selectionEnd,
        };
    }

    const step = indentationStep(value, lineStart, isOutdent);
    if (step === 0) return undefined;
    let offset = lineStart;
    let shift = 0;
    let caret = selectionEnd;
    const moved = lines.map((line) => {
        const delta = isOutdent
            ? -Math.min(step, leadingSpaces(line))
            : line.trim() === ''
              ? 0
              : step;
        if (selectionEnd >= offset && selectionEnd <= offset + line.length)
            caret = Math.max(offset + shift, selectionEnd + shift + delta);
        offset += line.length + 1;
        shift += delta;
        return delta > 0 ? ' '.repeat(delta) + line : line.slice(-delta);
    });
    if (shift === 0) return undefined;
    return { caret, from: lineStart, text: moved.join('\n'), to: blockEnd };
}
