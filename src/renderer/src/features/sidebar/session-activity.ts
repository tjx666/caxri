import { relativeTime } from '@caxri/utils';
import type { AgentActivityState, AgentOperation } from '@shared/types';

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
 * `--accent` is DESIGN.md's single per-screen focus color (the focused pane/tab); the Sidebar stays entirely neutral
 * otherwise, so unread-attention chrome borrows the same success/warning/danger/ neutral tone as the activity dot
 * instead. `border-danger`/`border-warning`/`bg-danger/10`/etc. are literal keys here (not built from a template
 * string) so Tailwind's static class scanner can find and generate them.
 */
const TONE_BORDER_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'border-danger',
    neutral: 'border-muted',
    success: 'border-success',
    warning: 'border-warning',
};

const TONE_BACKGROUND_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'bg-danger',
    neutral: 'bg-muted',
    success: 'bg-success',
    warning: 'bg-warning',
};

const TONE_CALLOUT_CLASSNAME: Record<SessionActivityPresentation['tone'], string> = {
    danger: 'bg-danger/10 text-danger',
    neutral: 'bg-muted/10 text-muted',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
};

/**
 * `border-*` utility for a tone-colored ring (e.g. the unread-attention indicator).
 */
export function sessionToneBorderClassName(tone: SessionActivityPresentation['tone']): string {
    return TONE_BORDER_CLASSNAME[tone];
}

/**
 * `bg-*` utility for a tone-colored dot/fill, matching {@link sessionToneBorderClassName}'s tone.
 */
export function sessionToneBackgroundClassName(tone: SessionActivityPresentation['tone']): string {
    return TONE_BACKGROUND_CLASSNAME[tone];
}

/**
 * Tone for the Sidebar unread indicator, which is deliberately coarser than {@link sessionActivityPresentation}.
 *
 * Every unread kind except an outright failure collapses to `warning`. The ring's job is "this row wants you", and a
 * `--muted` (or even `--foreground`) dot reads as inert chrome at sidebar-glance distance — which is exactly what the
 * most common attention kinds (`completed`/`idle`/`unknown`) used to resolve to. Collapsing the tone costs nothing: the
 * activity dot on the row's left edge still carries the full success/warning/danger/neutral state, and the hover card
 * names the attention kind outright. `danger` stays distinct because "the Agent failed" and "the Agent has something
 * for you" warrant different urgency at a glance.
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

export function formatSessionRelativeTime(timestamp: number, now = Date.now()): string {
    return relativeTime(timestamp, now);
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
