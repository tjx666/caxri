import type { AgentActivityState } from '@caxri/protocol';
import { normalizeTerminalTitle } from '@caxri/protocol';

/**
 * How a delegation's terminal transition reads in Caxri Bot's Terminal. `needsInput` covers both a startup prompt
 * (`startup_waiting`) and an in-task permission request (`permission_required`): both need the user's hands, and the
 * board already groups both under `attention` for the same reason.
 */
export type BotCompletionNoticeStatus = 'completed' | 'failed' | 'needsInput';

interface BotCompletionNoticeEntry {
    delegationId: string;
    sessionId: string;
    status: BotCompletionNoticeStatus;
}

/**
 * Flattens a value the completion notifier writes into Caxri Bot's Terminal to one control-character-free line, reusing
 * the same flatten/sanitize/cap `normalizeTerminalTitle` already applies to untrusted PTY and Agent-reported titles
 * (`packages/protocol/src/domain/terminal-title.ts`). Belt-and-suspenders here: these values already come from
 * validated records, but this text becomes literal PTY input, a stronger trust boundary than a JSON field, and an empty
 * identifier must still render as something rather than silently disappearing from the line.
 */
function sanitizeSingleLine(value: string): string {
    return normalizeTerminalTitle(value) ?? '?';
}

/**
 * What happened to a Bot Inbox item that Caxri Bot should act on: the owner replied, or the item closed without Caxri
 * Bot closing it (the owner merged or dismissed it, or GitHub reports its pull request merged or closed).
 */
export type BotInboxNoticeEvent = 'replied' | 'merged' | 'pullRequestClosed' | 'dismissed';

export interface BotInboxNoticeEntry {
    itemId: string;
    event: BotInboxNoticeEvent;
}

const INBOX_EVENT_LABEL: Record<BotInboxNoticeEvent, string> = {
    replied: 'has a new reply',
    merged: 'was merged',
    pullRequestClosed: 'closed with its pull request',
    dismissed: 'was dismissed by the user',
};

/**
 * What a hand-over tells Caxri Bot: the user handed it a Session whose Agent conversation it may continue now
 * (`ready`), once the Agent finishes the turn it is in (`busy`, followed by `ready`), or never (`ownership_only`: no
 * conversation to continue, so Caxri Bot starts a new task there instead).
 */
export type BotHandoverNoticeEvent = 'ready' | 'busy' | 'ownership_only';

export interface BotHandoverNoticeEntry {
    handoverId: string;
    sessionId: string;
    event: BotHandoverNoticeEvent;
}

const HANDOVER_EVENT_LABEL: Record<BotHandoverNoticeEvent, string> = {
    ready: 'is ready to continue',
    busy: 'is still in a turn; wait for its ready notice',
    ownership_only: 'has no conversation to continue; start a new task there',
};

/**
 * One hand-over clause: the hand-over and Session IDs and a closed event word, never the user's note or the Session's
 * title. Caxri Bot reads the note from the task ledger.
 */
function handoverNoticeClause(entry: BotHandoverNoticeEntry): string {
    return `hand-over ${sanitizeSingleLine(entry.handoverId)} of Session ${sanitizeSingleLine(
        entry.sessionId,
    )} ${HANDOVER_EVENT_LABEL[entry.event]}`;
}

/**
 * The activity states a Session notice reports. `unknown` is not one: it means Caxri lost track of the Agent, which
 * tells Caxri Bot nothing it could act on.
 */
export type BotSessionNoticeState = Exclude<AgentActivityState, 'unknown'>;

/**
 * A Session Caxri Bot manages changed state on its own: the user worked in it, or its Agent finished, failed, or asked
 * for input outside a task Caxri Bot dispatched.
 */
export interface BotSessionNoticeEntry {
    sessionId: string;
    state: BotSessionNoticeState;
}

const SESSION_STATE_LABEL: Record<BotSessionNoticeState, string> = {
    running: 'is working',
    waiting: 'needs input',
    completed: 'finished its turn',
    failed: 'failed its turn',
    idle: 'is idle',
};

/**
 * One Session clause: the Session ID and its latest state word, never its title or what its Agent wrote.
 */
function sessionNoticeClause(entry: BotSessionNoticeEntry): string {
    return `Session ${sanitizeSingleLine(entry.sessionId)} ${SESSION_STATE_LABEL[entry.state]}`;
}

/**
 * Everything one notice line reports.
 */
export interface BotNoticeBatch {
    delegations: readonly BotCompletionNoticeEntry[];
    inbox?: readonly BotInboxNoticeEntry[];
    handovers?: readonly BotHandoverNoticeEntry[];
    sessions?: readonly BotSessionNoticeEntry[];
}

function noticeUpdateCount(count: number, noun: string): string {
    return count === 1 ? `1 ${noun}update` : `${count} ${noun}updates`;
}

/**
 * One Inbox clause of a notice line: the item ID and a closed event word, never the item's title, body, or reply.
 */
function inboxNoticeClause(entry: BotInboxNoticeEntry): string {
    return `inbox item ${sanitizeSingleLine(entry.itemId)} ${INBOX_EVENT_LABEL[entry.event]}`;
}

/**
 * The count before a notice's clauses, naming the kind only when every clause shares it.
 */
function noticeSummary(counts: Array<[count: number, noun: string]>): string {
    const total = counts.reduce((sum, [count]) => sum + count, 0);
    const [count, noun] = counts.find(([kindCount]) => kindCount === total) ?? [total, ''];
    return noticeUpdateCount(count, noun);
}

function noticeCount(batch: BotNoticeBatch): number {
    return (
        batch.delegations.length +
        (batch.inbox?.length ?? 0) +
        (batch.handovers?.length ?? 0) +
        (batch.sessions?.length ?? 0)
    );
}

const STATUS_LABEL: Record<BotCompletionNoticeStatus, string> = {
    completed: 'completed',
    failed: 'failed',
    needsInput: 'needs your input',
};

/**
 * Builds the single injected line for one or more coalesced transitions. Content is Server-generated only: a delegation
 * ID, a Session ID, and a closed status word, never a transcript or Agent-authored text. Multiple pending transitions
 * join into this one line instead of one injection per delegation, so a Caxri Bot that was busy through several
 * completions still receives exactly one line to read.
 */
export function formatBotCompletionNotice({
    delegations,
    inbox = [],
    handovers = [],
    sessions = [],
}: BotNoticeBatch): string {
    const clauses = [
        ...delegations.map(
            (entry) =>
                `delegation ${sanitizeSingleLine(entry.delegationId)} in Session ${sanitizeSingleLine(
                    entry.sessionId,
                )} ${STATUS_LABEL[entry.status]}`,
        ),
        ...inbox.map((entry) => inboxNoticeClause(entry)),
        ...handovers.map((entry) => handoverNoticeClause(entry)),
        ...sessions.map((entry) => sessionNoticeClause(entry)),
    ];
    const summary = noticeSummary([
        [delegations.length, 'delegation '],
        [inbox.length, 'inbox '],
        [handovers.length, 'hand-over '],
        [sessions.length, 'Session '],
    ]);
    return `[Caxri notice] ${summary}: ${clauses.join('; ')}.`;
}

/**
 * The line a relaunched Caxri Bot receives as its first prompt. It names what Caxri Bot missed while it was not running
 * (a turn that never finished, delegations that settled), never what they produced, and tells it to reconcile before
 * acting. Server-generated only, like every notice.
 */
export function formatBotResumePrompt(batch: BotNoticeBatch, wasTurnInterrupted: boolean): string {
    const parts = ['[Caxri notice] Caxri Bot restarted.'];
    if (wasTurnInterrupted)
        parts.push(
            'Your previous turn did not finish: Caxri or your Agent CLI restarted, or the turn was interrupted. Continue it unless the user stopped it on purpose.',
        );
    if (noticeCount(batch) > 0)
        parts.push(formatBotCompletionNotice(batch).replace('[Caxri notice] ', 'Missed '));
    parts.push(
        'Reconcile with `bot task list` and `bot board` before you act, then report under Reporting.',
    );
    return parts.join(' ');
}
