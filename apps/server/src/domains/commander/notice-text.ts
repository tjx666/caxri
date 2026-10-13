import { normalizeTerminalTitle } from '@caxri/protocol';

/**
 * How a delegation's terminal transition reads in the Commander Terminal. `needsInput` covers both a startup prompt
 * (`startup_waiting`) and an in-task permission request (`permission_required`): both need the user's hands, and the
 * board already groups both under `attention` for the same reason.
 */
export type CommanderCompletionNoticeStatus = 'completed' | 'failed' | 'needsInput';

export interface CommanderCompletionNoticeEntry {
    delegationId: string;
    sessionId: string;
    status: CommanderCompletionNoticeStatus;
}

/**
 * Flattens a value the completion notifier writes into the Commander Terminal to one control-character-free line,
 * reusing the same flatten/sanitize/cap `normalizeTerminalTitle` already applies to untrusted PTY and Agent-reported
 * titles (`packages/protocol/src/domain/terminal-title.ts`). Belt-and-suspenders here: these values already come from
 * validated records, but this text becomes literal PTY input, a stronger trust boundary than a JSON field, and an empty
 * identifier must still render as something rather than silently disappearing from the line.
 */
function sanitizeSingleLine(value: string): string {
    return normalizeTerminalTitle(value) ?? '?';
}

/**
 * What happened to a Commander Inbox item that the Commander should act on: the owner replied, or the item closed
 * without the Commander closing it (the owner merged or dismissed it, or GitHub reports its pull request merged or
 * closed).
 */
export type CommanderInboxNoticeEvent = 'replied' | 'merged' | 'pullRequestClosed' | 'dismissed';

export interface CommanderInboxNoticeEntry {
    itemId: string;
    event: CommanderInboxNoticeEvent;
}

const INBOX_EVENT_LABEL: Record<CommanderInboxNoticeEvent, string> = {
    replied: 'has a new reply',
    merged: 'was merged',
    pullRequestClosed: 'closed with its pull request',
    dismissed: 'was dismissed by the user',
};

/**
 * What a hand-over tells the Commander: the user handed it a Session whose Agent conversation it may continue now
 * (`ready`), once the Agent finishes the turn it is in (`busy`, followed by `ready`), or never (`ownership_only`: no
 * conversation to continue, so the Commander starts a new task there instead).
 */
export type CommanderHandoverNoticeEvent = 'ready' | 'busy' | 'ownership_only';

export interface CommanderHandoverNoticeEntry {
    handoverId: string;
    sessionId: string;
    event: CommanderHandoverNoticeEvent;
}

const HANDOVER_EVENT_LABEL: Record<CommanderHandoverNoticeEvent, string> = {
    ready: 'is ready to continue',
    busy: 'is still in a turn; wait for its ready notice',
    ownership_only: 'has no conversation to continue; start a new task there',
};

/**
 * One hand-over clause: the hand-over and Session IDs and a closed event word, never the user's note or the Session's
 * title. The Commander reads the note from the task ledger.
 */
function handoverNoticeClause(entry: CommanderHandoverNoticeEntry): string {
    return `hand-over ${sanitizeSingleLine(entry.handoverId)} of Session ${sanitizeSingleLine(
        entry.sessionId,
    )} ${HANDOVER_EVENT_LABEL[entry.event]}`;
}

function noticeUpdateCount(count: number, noun: string): string {
    return count === 1 ? `1 ${noun}update` : `${count} ${noun}updates`;
}

/**
 * One Inbox clause of a notice line: the item ID and a closed event word, never the item's title, body, or reply.
 */
function inboxNoticeClause(entry: CommanderInboxNoticeEntry): string {
    return `inbox item ${sanitizeSingleLine(entry.itemId)} ${INBOX_EVENT_LABEL[entry.event]}`;
}

/**
 * The count before a notice's clauses, naming the kind only when every clause shares it.
 */
function noticeSummary(delegationCount: number, inboxCount: number, handoverCount: number): string {
    const total = delegationCount + inboxCount + handoverCount;
    if (total === delegationCount) return noticeUpdateCount(delegationCount, 'delegation ');
    if (total === inboxCount) return noticeUpdateCount(inboxCount, 'inbox ');
    if (total === handoverCount) return noticeUpdateCount(handoverCount, 'hand-over ');
    return noticeUpdateCount(total, '');
}

const STATUS_LABEL: Record<CommanderCompletionNoticeStatus, string> = {
    completed: 'completed',
    failed: 'failed',
    needsInput: 'needs your input',
};

/**
 * Builds the single injected line for one or more coalesced transitions. Content is Server-generated only: a delegation
 * ID, a Session ID, and a closed status word, never a transcript or Agent-authored text. Multiple pending transitions
 * join into this one line instead of one injection per delegation, so a Commander that was busy through several
 * completions still receives exactly one line to read.
 */
export function formatCommanderCompletionNotice(
    entries: readonly CommanderCompletionNoticeEntry[],
    inboxEntries: readonly CommanderInboxNoticeEntry[] = [],
    handoverEntries: readonly CommanderHandoverNoticeEntry[] = [],
): string {
    const clauses = [
        ...entries.map(
            (entry) =>
                `delegation ${sanitizeSingleLine(entry.delegationId)} in Session ${sanitizeSingleLine(
                    entry.sessionId,
                )} ${STATUS_LABEL[entry.status]}`,
        ),
        ...inboxEntries.map((entry) => inboxNoticeClause(entry)),
        ...handoverEntries.map((entry) => handoverNoticeClause(entry)),
    ];
    const summary = noticeSummary(entries.length, inboxEntries.length, handoverEntries.length);
    return `[Caxri notice] ${summary}: ${clauses.join('; ')}.`;
}

/**
 * The line a relaunched Commander receives as its first prompt. It names what the Commander missed while it was not
 * running (a turn that never finished, delegations that settled), never what they produced, and tells it to reconcile
 * before acting. Server-generated only, like every notice.
 */
export function formatCommanderResumePrompt(
    entries: readonly CommanderCompletionNoticeEntry[],
    wasTurnInterrupted: boolean,
    inboxEntries: readonly CommanderInboxNoticeEntry[] = [],
    handoverEntries: readonly CommanderHandoverNoticeEntry[] = [],
): string {
    const parts = ['[Caxri notice] The Agent Commander restarted.'];
    if (wasTurnInterrupted)
        parts.push(
            'Your previous turn did not finish: Caxri or your Agent CLI restarted, or the turn was interrupted. Continue it unless the user stopped it on purpose.',
        );
    if (entries.length + inboxEntries.length + handoverEntries.length > 0)
        parts.push(
            formatCommanderCompletionNotice(entries, inboxEntries, handoverEntries).replace(
                '[Caxri notice] ',
                'Missed ',
            ),
        );
    parts.push(
        'Reconcile with `commander task list` and `commander board` before you act, then report under Reporting.',
    );
    return parts.join(' ');
}
