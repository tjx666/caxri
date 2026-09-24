import type { MobileSessionItem } from './session-model';

export const sessionAgentLabel = (session: MobileSessionItem): string => {
    switch (session.primaryTerminal?.kind) {
        case 'claude':
            return 'Claude Code';
        case 'codex':
            return 'Codex';
        case 'grok':
            return 'Grok';
        case 'shell':
            return 'Shell';
        default:
            return 'No Agent';
    }
};

export const sessionAgeLabel = (lastOpenedAt: number, now: number): string => {
    const minutes = Math.max(0, Math.floor((now - lastOpenedAt) / 60_000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
};
