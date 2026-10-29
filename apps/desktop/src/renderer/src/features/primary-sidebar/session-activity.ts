import type {
    AgentActivityState,
    AgentOperation,
    SessionRecord,
    TerminalKind,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { settingCategoryPath } from '../settings/setting-spec-text';
import type { SessionStatusTerminal } from './session-status';

export interface SessionActivityPresentation {
    ariaLabel: string;
    description: string;
    indicatorClassName: string;
    label: string;
    tone: 'danger' | 'neutral' | 'success' | 'warning';
}

type ActivityKey =
    'background' | 'compacting' | 'detached' | 'noAgent' | 'suspended' | AgentActivityState;

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
 * Resolves the label and sentence through the caller's `t` so a language change is picked up by the next render; the
 * tone and class name tables stay static.
 */
function presentation(
    key: ActivityKey,
    tone: SessionActivityPresentation['tone'],
    indicatorClassName: string,
    t: Translate,
): SessionActivityPresentation {
    const label = t(`primarySidebar.activity.${key}.label`);
    /**
     * Only the `suspended` sentence has a `{{settingsPath}}` placeholder; the others ignore the parameter.
     */
    const description = t(`primarySidebar.activity.${key}.description`, {
        settingsPath: settingCategoryPath(t, 'terminal.idleSuspension.enabled'),
    });
    return {
        ariaLabel: t('primarySidebar.activity.ariaLabel', { description, label }),
        description,
        indicatorClassName,
        label,
        tone,
    };
}

/**
 * Tone for an unread attention mark, which is deliberately coarser than {@link sessionActivityPresentation}.
 *
 * Every unread kind except an outright failure collapses to `warning`. A `--muted` mark reads as inert chrome, which is
 * exactly what the most common attention kinds (`completed`/`idle`/`unknown`) resolve to, while `danger` stays distinct
 * because a failed turn warrants different emphasis.
 */
export function sessionUnreadTone(kind: AgentActivityState): SessionActivityPresentation['tone'] {
    return PRESENTATIONS[kind].tone === 'danger' ? 'danger' : 'warning';
}

/**
 * Single source of truth for every visual and accessible Session activity explanation.
 */
export function sessionActivityPresentation(
    state: AgentActivityState,
    operation: AgentOperation | undefined,
    t: Translate,
): SessionActivityPresentation {
    if (operation === 'compacting') return presentation('compacting', 'success', 'text-success', t);
    // The turn ended and waits on work that wakes the Agent again: still running, but nothing to watch.
    if (operation === 'background') return presentation('background', 'neutral', 'text-muted', t);
    const { indicatorClassName, tone } = PRESENTATIONS[state];
    return presentation(state, tone, indicatorClassName, t);
}

/**
 * What the Session's Agent is doing right now, as the hover card words it. `terminal.kind` is the Session's Terminal
 * kind; a `shell` kind reads as having no Agent instead of borrowing an Agent's activity wording.
 */
export function currentSessionActivityPresentation(
    session: Pick<SessionRecord, 'agentActivityState'>,
    terminal: (SessionStatusTerminal & { kind?: TerminalKind }) | undefined,
    t: Translate,
): SessionActivityPresentation {
    // A Shell Session has no Agent, so its card must not claim one is idle or working.
    if (terminal?.kind === 'shell') return presentation('noAgent', 'neutral', 'text-muted', t);
    // A detached Agent was stopped on purpose so another client can resume it; the last probed lifecycle state would
    // misreport it as still working or waiting.
    if (terminal?.lastProcessState === 'detached') {
        return {
            ...presentation('detached', 'neutral', 'text-muted', t),
            ariaLabel: t('primarySidebar.activity.detached.ariaLabel'),
        };
    }
    // A suspended Agent was parked while its Session sat in the background; opening the Session resumes it. The sentence
    // stays neutral about the cause because the record does not say whether the idle rule, an archive, or a Process
    // Explorer stop parked it.
    if (terminal?.lastProcessState === 'suspended') {
        return presentation('suspended', 'neutral', 'text-muted', t);
    }
    return sessionActivityPresentation(session.agentActivityState, terminal?.agentOperation, t);
}
