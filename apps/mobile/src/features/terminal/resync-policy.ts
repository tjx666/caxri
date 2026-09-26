export type TerminalResyncReason =
    'capacity' | 'generation-changed' | 'local' | 'resize' | 'source-gap';

export const terminalResyncPlan = (
    reason: TerminalResyncReason,
): { showStale: boolean; useBackoff: boolean } =>
    reason === 'resize'
        ? { showStale: false, useBackoff: false }
        : { showStale: true, useBackoff: true };
