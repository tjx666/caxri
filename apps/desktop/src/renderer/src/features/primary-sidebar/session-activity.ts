import type {
    AgentActivityState,
    AgentOperation,
    SessionRecord,
    TerminalKind,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import type { SessionStatusTerminal } from './session-status';

export interface SessionActivityPresentation {
    ariaLabel: string;
    description: string;
    indicatorClassName: string;
    label: string;
    tone: 'danger' | 'neutral' | 'success' | 'warning';
}

type ActivityKey = 'compacting' | 'detached' | 'noAgent' | 'suspended' | AgentActivityState;

const PRESENTATIONS: Record<
    AgentActivityState,
    Pick<SessionActivityPresentation, 'indicatorClassName' | 'tone'>
> = {
    completed: { tone: 'neutral', indicatorClassName: 'text-muted' },
    failed: { tone: 'danger', indicatorClassName: 'text-danger' },
    idle: { tone: 'neutral', indicatorClassName: 'text-muted' },
    running: { tone: 'success', indicatorClassName: 'text-success' },
    unknown: { tone: 'neutral', indicatorClassName: 'text-muted' },
    waiting: { tone: 'warning', indicatorClassName: 'text-warning' },
};

/**
 * Resolves the label and sentence at call time so a language change is picked up by the next render; the tone and class
 * name tables stay static.
 */
function presentation(
    key: ActivityKey,
    tone: SessionActivityPresentation['tone'],
    indicatorClassName: string,
): SessionActivityPresentation {
    const label = translate(`primarySidebar.activity.${key}.label`);
    const description = translate(`primarySidebar.activity.${key}.description`);
    return {
        ariaLabel: translate('primarySidebar.activity.ariaLabel', { description, label }),
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
    if (operation === 'compacting') return presentation('compacting', 'success', 'text-success');
    const { indicatorClassName, tone } = PRESENTATIONS[state];
    return presentation(state, tone, indicatorClassName);
}

/**
 * What the Session's Agent is doing right now, as the hover card words it. `terminal.kind` is the Session's Terminal
 * kind; a `shell` kind reads as having no Agent instead of borrowing an Agent's activity wording.
 */
export function currentSessionActivityPresentation(
    session: Pick<SessionRecord, 'lastActivityState'>,
    terminal?: SessionStatusTerminal & { kind?: TerminalKind },
): SessionActivityPresentation {
    // A Shell Session has no Agent, so its card must not claim one is idle or working.
    if (terminal?.kind === 'shell') return presentation('noAgent', 'neutral', 'text-muted');
    // A detached Agent was stopped on purpose so another client can resume it; the last probed lifecycle state would
    // misreport it as still working or waiting.
    if (terminal?.lastProcessState === 'detached') {
        return {
            ...presentation('detached', 'neutral', 'text-muted'),
            ariaLabel: translate('primarySidebar.activity.detached.ariaLabel'),
        };
    }
    // A suspended Agent was parked while its Session sat in the background; opening the Session resumes it. The sentence
    // stays neutral about the cause because the record does not say whether the idle rule, an archive, or a Process
    // Explorer stop parked it.
    if (terminal?.lastProcessState === 'suspended') {
        return presentation('suspended', 'neutral', 'text-muted');
    }
    return sessionActivityPresentation(session.lastActivityState, terminal?.agentOperation);
}
