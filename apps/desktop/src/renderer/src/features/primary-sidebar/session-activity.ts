import type { AgentActivityState, AgentOperation, SessionRecord } from '@caxri/protocol';

import type { SessionStatusTerminal } from './session-status';

export interface SessionActivityPresentation {
    ariaLabel: string;
    description: string;
    indicatorClassName: string;
    label: string;
    tone: 'danger' | 'neutral' | 'success' | 'warning';
}

const PRESENTATIONS: Record<AgentActivityState, SessionActivityPresentation> = {
    completed: presentation(
        'Finished',
        'The Agent finished its latest turn.',
        'neutral',
        'text-muted',
    ),
    failed: presentation(
        'Failed',
        'The latest reliable Agent state is a failure.',
        'danger',
        'text-danger',
    ),
    idle: presentation('Idle', 'The Agent is currently idle.', 'neutral', 'text-muted'),
    running: presentation('Working', 'The Agent is running.', 'success', 'text-success'),
    unknown: presentation(
        'No activity reported',
        'No reliable Agent activity is available.',
        'neutral',
        'text-muted',
    ),
    waiting: presentation(
        'Waiting for you',
        'The Agent is waiting for input or confirmation.',
        'warning',
        'text-warning',
    ),
};

const COMPACTION_PRESENTATION = presentation(
    'Compacting',
    'Codex is summarizing earlier context before continuing.',
    'success',
    'text-success',
);

function presentation(
    label: string,
    description: string,
    tone: SessionActivityPresentation['tone'],
    indicatorClassName: string,
): SessionActivityPresentation {
    return {
        ariaLabel: `${label}. ${description}`,
        description,
        indicatorClassName,
        label,
        tone,
    };
}

/**
 * `--accent` is DESIGN.md's single per-screen focus color (the focused pane/tab); the PrimarySidebar stays entirely
 * neutral otherwise, so detailed activity chrome borrows the same success/warning/danger/neutral tones instead.
 * `bg-danger`/`bg-warning`/`bg-danger/10`/etc. are literal keys here (not built from a template string) so Tailwind's
 * static class scanner can find and generate them.
 */
const TONE_CALLOUT_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'bg-danger/10 text-danger',
    neutral: 'bg-muted/10 text-muted',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
};

/**
 * Tone for the hover card's unread explanation, which is deliberately coarser than {@link sessionActivityPresentation}.
 *
 * Every unread kind except an outright failure collapses to `warning`. A `--muted` detail chip reads as inert chrome,
 * which is exactly what the most common attention kinds (`completed`/`idle`/`unknown`) resolve to. The hover card names
 * the attention kind outright, while `danger` stays distinct in that detail surface because a failed turn warrants
 * different explanatory emphasis.
 */
export function sessionUnreadTone(kind: AgentActivityState): SessionActivityPresentation['tone'] {
    return PRESENTATIONS[kind].tone === 'danger' ? 'danger' : 'warning';
}

/**
 * Soft background + matching text for a tone-colored callout chip (e.g. the unread explanation).
 */
export function sessionToneCalloutClassName(tone: SessionActivityPresentation['tone']): string {
    return TONE_CALLOUT_CLASSNAME[tone];
}

/**
 * Single source of truth for every visual and accessible Session activity explanation.
 */
export function sessionActivityPresentation(
    state: AgentActivityState,
    operation?: AgentOperation,
): SessionActivityPresentation {
    if (operation === 'compacting') return COMPACTION_PRESENTATION;
    return PRESENTATIONS[state];
}

/**
 * A detached Agent was stopped on purpose so another client can resume it; the last probed lifecycle state would
 * misreport it as still working or waiting here.
 */
const DETACHED_PRESENTATION: SessionActivityPresentation = {
    ariaLabel: 'Detached. The Agent was stopped so another client can resume it.',
    description:
        'Stopped so another client can resume this conversation. Resume it from the row menu.',
    indicatorClassName: 'text-muted',
    label: 'Detached',
    tone: 'neutral',
};

/**
 * What the Session's Agent is doing right now, as the hover card and the row's status line both word it.
 */
export function currentSessionActivityPresentation(
    session: Pick<SessionRecord, 'lastActivityState'>,
    terminal?: SessionStatusTerminal,
): SessionActivityPresentation {
    if (terminal?.lastProcessState === 'detached') return DETACHED_PRESENTATION;
    return sessionActivityPresentation(session.lastActivityState, terminal?.agentOperation);
}

/**
 * The activity the row's status line names, or `undefined` when it should show only the time. A Shell-only Session
 * never reports activity, and spelling out "No activity reported" on every such row is noise the hover card already
 * covers.
 */
export function sessionStatusLineActivity(
    session: Pick<SessionRecord, 'lastActivityState'>,
    terminal?: SessionStatusTerminal,
): SessionActivityPresentation | undefined {
    const activity = currentSessionActivityPresentation(session, terminal);
    return activity === PRESENTATIONS.unknown ? undefined : activity;
}
