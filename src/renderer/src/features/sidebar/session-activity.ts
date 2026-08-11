import type { AgentActivityState } from '@shared/types';

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const RELATIVE_TIME_RANGES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

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

export function formatSessionRelativeTime(timestamp: number, now = Date.now()): string {
    const seconds = Math.round((timestamp - now) / 1_000);
    for (const [unit, size] of RELATIVE_TIME_RANGES) {
        if (Math.abs(seconds) >= size)
            return RELATIVE_TIME_FORMATTER.format(Math.round(seconds / size), unit);
    }
    return RELATIVE_TIME_FORMATTER.format(seconds, 'second');
}

/** Single source of truth for every visual and accessible Session activity explanation. */
export function sessionActivityPresentation(
    state: AgentActivityState,
): SessionActivityPresentation {
    return PRESENTATIONS[state];
}
