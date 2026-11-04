import type { CaxriMethod } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type {
    AgentEndpointCredential,
    CliAutomation,
    DelegationClientCredential,
} from './environment';

/**
 * Non-secret hints `agent delegate access launch` exports next to the credential, so the launched Agent can omit
 * `--project` and `--session` on every `create`. The Server still validates both against the credential.
 */
export const DELEGATION_PROJECT_ENVIRONMENT = 'CAXRI_DELEGATION_PROJECT_ID';
export const DELEGATION_SESSION_ENVIRONMENT = 'CAXRI_DELEGATION_SESSION_ID';

/**
 * Delegation and dispatch methods reach the Server as the profile owner when no credential is present, which would give
 * any Agent started outside Caxri unrestricted delegation. An Agent-recognized invocation therefore needs a complete
 * Endpoint or delegation credential. This is checked on the resolved method, so the generic `request` entry point is
 * covered along with the named commands. A human in a plain shell, and CI, keep owner authority.
 */
export function assertAgentDelegationCredential(
    method: CaxriMethod,
    automation: CliAutomation,
    credential: AgentEndpointCredential | DelegationClientCredential | undefined,
): void {
    if (automation !== 'agent' || credential !== undefined) return;
    if (!method.startsWith('agent.delegation.') && !method.startsWith('agent.dispatch.')) return;
    throw new CaxriError(
        'FORBIDDEN',
        'This Agent has no delegation credential. Ask the user to start it with `caxri agent delegate access launch -- <agent>`, or run it in a Caxri Terminal',
    );
}

function hasAny(tokens: readonly string[], flags: readonly string[]): boolean {
    return flags.some((flag) => tokens.includes(flag));
}

/**
 * Fills `--project` and `--session` from the launch environment for a delegation-client credential. An explicit target
 * always wins, `--new-session` never receives a default Session, and `--project-path` never receives a Project ID, so a
 * default cannot turn a valid request into a conflicting one.
 */
export function withDelegationDefaults(
    method: CaxriMethod,
    tokens: readonly string[],
    environment: NodeJS.ProcessEnv,
    credential: DelegationClientCredential | undefined,
): readonly string[] {
    if (!credential) return tokens;
    if (method !== 'agent.delegation.create' && method !== 'agent.delegation.presets')
        return tokens;
    const projectId = environment[DELEGATION_PROJECT_ENVIRONMENT];
    const sessionId = environment[DELEGATION_SESSION_ENVIRONMENT];
    const defaults: string[] = [];
    if (projectId && !hasAny(tokens, ['--project', '--project-path']))
        defaults.push('--project', projectId);
    if (sessionId && !hasAny(tokens, ['--session', '--new-session']))
        defaults.push('--session', sessionId);
    return defaults.length === 0 ? tokens : [...tokens, ...defaults];
}
