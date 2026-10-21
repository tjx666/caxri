import type { CommandExecutionContext } from '@caxri/protocol';
import { CaxriError, getMethodSpec } from '@caxri/protocol';

export const projectScope = (context: CommandExecutionContext): string[] | null => {
    switch (context.principal.kind) {
        case 'agent':
        case 'delegation-client':
        case 'extension':
        case 'paired-device':
            return [...context.principal.projectIds];
        default:
            return null;
    }
};

export const assertProjectScope = (context: CommandExecutionContext, projectId: string): void => {
    const scope = projectScope(context);
    if (scope && !scope.includes(projectId))
        throw new CaxriError('FORBIDDEN', 'Agent control is outside the granted Project');
};

/**
 * Refuses a method whose spec declares `principal: 'owner'` for every principal except the user's own clients (Desktop,
 * human CLI). Capabilities cannot do this: an `agent:control` grant gives an Agent Endpoint the same ones. The spec is
 * the only source, so a new owner-only method cannot be left open by a forgotten list.
 */
export const assertOwnerOnlyMethod = (context: CommandExecutionContext, method: string): void => {
    if (getMethodSpec(method)?.principal !== 'owner') return;
    if (context.principal.kind === 'desktop' || context.principal.kind === 'human-cli') return;
    throw new CaxriError('FORBIDDEN', 'This method is restricted to the owner');
};
