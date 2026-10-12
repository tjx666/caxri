import type { Translate } from '../../i18n';

export type AgentActionTargetTitle =
    | { kind: 'shared'; title: string }
    | { kind: 'distinct'; sessionTitle: string; terminalTitle: string };

function normalizedTitle(title: string | undefined, fallback: string): string {
    const normalized = title?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
}

export function resolveAgentActionTargetTitle(
    sessionTitle: string | undefined,
    terminalTitle: string | undefined,
    t: Translate,
): AgentActionTargetTitle {
    const normalizedSessionTitle = normalizedTitle(
        sessionTitle,
        t('agentActions.target.fallbackSession'),
    );
    const normalizedTerminalTitle = normalizedTitle(
        terminalTitle,
        t('agentActions.target.fallbackTerminal'),
    );
    if (normalizedSessionTitle === normalizedTerminalTitle)
        return { kind: 'shared', title: normalizedSessionTitle };
    return {
        kind: 'distinct',
        sessionTitle: normalizedSessionTitle,
        terminalTitle: normalizedTerminalTitle,
    };
}

export function describeAgentActionTarget(
    providerName: string,
    target: AgentActionTargetTitle,
    t: Translate,
): string {
    return target.kind === 'shared'
        ? t('agentActions.target.sharedLabel', { provider: providerName, title: target.title })
        : t('agentActions.target.distinctLabel', {
              provider: providerName,
              session: target.sessionTitle,
              terminal: target.terminalTitle,
          });
}
