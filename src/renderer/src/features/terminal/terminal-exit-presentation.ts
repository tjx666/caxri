import type { ProcessState } from '@shared/types';

export interface TerminalExitPresentation {
    icon: 'completed' | 'failed' | 'unexpected';
    label: string;
    tone: 'neutral' | 'danger';
}

export function getTerminalExitPresentation(
    state: ProcessState,
): TerminalExitPresentation | undefined {
    switch (state) {
        case 'stopped':
            return { icon: 'completed', label: 'Process exited normally', tone: 'neutral' };
        case 'failed':
            return { icon: 'failed', label: 'Terminal failed to start', tone: 'danger' };
        case 'dead':
            return { icon: 'unexpected', label: 'Terminal stopped unexpectedly', tone: 'danger' };
        case 'interrupted':
            return {
                icon: 'unexpected',
                label: 'Interrupted by app shutdown — restoring',
                tone: 'neutral',
            };
        case 'starting':
        case 'running':
            return undefined;
    }
}
