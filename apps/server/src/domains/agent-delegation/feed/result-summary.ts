import type { DelegationResultSource } from '@caxri/protocol';
import { MAX_DELEGATION_RESULT_SUMMARY_LENGTH } from '@caxri/protocol';

import { clipToLength } from '../../agents';

/**
 * The label of the closing line a delegated Agent was told to write (`DELEGATION_SUMMARY_INSTRUCTION`), tolerating the
 * Markdown emphasis Agents put around it (`**Summary:** ...`, `**Summary**: ...`, `**Summary** ...`). The label must
 * end in a colon or in closing emphasis followed by a space or the end of the line, so a line that merely starts with
 * the word (`Summary of changes`, `Summary_of_changes`) is not taken for it.
 *
 * - Group 1 is the emphasis that opens the label (`**` in `**Summary:`), absent for a bare label.
 * - Group 2 is the emphasis that closes it before the colon (`**` in `**Summary**:`), absent otherwise.
 * - Group 3 is everything after the label. It may still hold the label's closing emphasis (`**Summary:** x` leaves `**
 *   x`) or its closer at the far end (`**Summary: x**` leaves ` x**`); {@link authoredText} separates those from the
 *   summary's own text.
 */
const SUMMARY_LABEL = /^\s*(?:([*_]{1,3})\s*)?Summary(?::|([*_]{1,3})(?::|(?=\s|$)))(.*)$/iu;

/**
 * How many of the answer's last non-empty lines may hold the summary line. The instruction asks for it last; a few
 * lines of slack cover a sign-off after it without letting a `Summary:` line from the middle of the answer count.
 */
const SUMMARY_TAIL_LINES = 5;

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;
const FENCE = /^\s{0,3}(?:```|~~~)/u;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/u;
const EMPHASIS_RUN = /^[*_]{1,3}/u;
const WRAPPED_IN_EMPHASIS = /^(\*{1,3}|_{1,3})(?=[^\s*_])(.+?)(?<=[^\s*_])\1$/u;
const ONLY_EMPHASIS = /^[\s*_]*$/u;

function oneLine(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * How the label around a captured summary uses emphasis: the run that opened it (`**` in `**Summary: x**`) and whether
 * a closer was already seen before the text (`**Summary**: x`).
 */
interface LabelEmphasis {
    opener?: string;
    isClosed: boolean;
}

/**
 * The captured text without the closer of its label. `**Summary:** x` and `*Summary:* x` leave the closer glued to the
 * colon, so the run right after the colon is the closer when whitespace or the end follows it (`** x`), or when it is
 * the opener again (`**Summary:**x`). Otherwise it belongs to the text: `Summary:*args fixed` keeps its `*args`.
 */
function withoutLabelCloser(captured: string, label: LabelEmphasis): [string, boolean] {
    if (label.isClosed) return [captured, true];
    const run = EMPHASIS_RUN.exec(captured)?.[0];
    if (!run) return [captured, false];
    const after = captured.slice(run.length);
    const isCloser = after === '' || /^\s/u.test(after) || run === label.opener;
    return isCloser ? [after, true] : [captured, false];
}

/**
 * The text of a captured summary: whitespace collapsed, and only the emphasis that belongs to the label or wraps the
 * whole text dropped.
 *
 * - The label's closer, wherever it stands: right after the colon (`**Summary:** x`).
 * - The label's opener, when the label never closed: the same run at the end of the text (`**Summary: x**`), if every
 *   other run of it inside the text is already paired, so `__Summary: renamed __init__` keeps the `__init__` it names.
 * - A single pair around everything (`_x_`, `**x**`), unless the text holds that run again (`**a** and **b**`).
 *
 * Every other `*`, `_` and `:` is the summary's own and stays: `__init__`, `*args`, `src/**`, and `exit: 0):` survive.
 * A capture holding nothing but emphasis (`**` from `**Summary:**`) is empty. Without a `label` (the line after a label
 * that stands alone) there is no label emphasis to remove, only a wrapping pair.
 */
function authoredText(captured: string, label?: LabelEmphasis): string {
    const [afterCloser, isClosed] = label ? withoutLabelCloser(captured, label) : [captured, true];
    let text = oneLine(afterCloser);
    const opener = label?.opener;
    if (!isClosed && opener && text.endsWith(opener)) {
        const before = text.slice(0, -opener.length).trimEnd();
        if ((before.split(opener).length - 1) % 2 === 0) text = before;
    }
    const wrapped = WRAPPED_IN_EMPHASIS.exec(text);
    if (wrapped && !wrapped[2].includes(wrapped[1])) text = wrapped[2];
    return ONLY_EMPHASIS.test(text) ? '' : text;
}

/**
 * The text on the line after a label that stands alone, which Agents write as a heading-like line followed by the
 * summary (`**Summary:**` then `Fixed the race.` or `- Fixed the race.`). A heading or a code fence is not a summary.
 */
function followingText(line: string): string {
    return HEADING.test(line) || FENCE.test(line)
        ? ''
        : authoredText(line.replace(LIST_MARKER, ''));
}

function authoredSummary(lines: readonly string[]): string | undefined {
    const tail = lines.filter((candidate) => candidate.trim() !== '').slice(-SUMMARY_TAIL_LINES);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
        const match = SUMMARY_LABEL.exec(tail[index]);
        if (!match) continue;
        const [, opener, closer, captured] = match;
        const text =
            authoredText(captured, { opener, isClosed: Boolean(closer) }) ||
            followingText(tail[index + 1] ?? '');
        if (text) return text;
    }
    return undefined;
}

/**
 * The first paragraph of prose: a run of lines outside code fences, ended by a blank line, a heading, or a fence.
 */
function firstParagraph(lines: readonly string[]): string | undefined {
    const paragraph: string[] = [];
    let isFenced = false;
    for (const line of lines) {
        if (FENCE.test(line)) {
            isFenced = !isFenced;
            if (paragraph.length > 0) break;
            continue;
        }
        if (isFenced) continue;
        if (line.trim() === '' || HEADING.test(line)) {
            if (paragraph.length > 0) break;
            continue;
        }
        paragraph.push(line);
    }
    return oneLine(paragraph.join(' ')) || undefined;
}

/**
 * The one-line result of a delegated task's final answer, for the Delegated Sessions feed.
 *
 * - `authored`: the answer's closing `Summary:` line, the last one among its final five non-empty lines. A label that
 *   stands alone on its line takes the next non-empty line as its text.
 * - `excerpt`: otherwise, the answer's first paragraph that is neither a heading nor a code fence, whitespace collapsed.
 *
 * Both are clipped to {@link MAX_DELEGATION_RESULT_SUMMARY_LENGTH} characters with an ellipsis. An answer with no text
 * has no summary.
 */
export function delegationResultSummary(
    answerText: string,
): { text: string; source: DelegationResultSource } | undefined {
    const lines = answerText.split(/\r?\n/u);
    const authored = authoredSummary(lines);
    if (authored)
        return {
            text: clipToLength(authored, MAX_DELEGATION_RESULT_SUMMARY_LENGTH),
            source: 'authored',
        };
    const excerpt = firstParagraph(lines);
    return excerpt
        ? { text: clipToLength(excerpt, MAX_DELEGATION_RESULT_SUMMARY_LENGTH), source: 'excerpt' }
        : undefined;
}
