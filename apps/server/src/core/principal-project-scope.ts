import type { CommandExecutionContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

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
 * Commander hand-over is the user's action, and it spans Projects by design (a conversation import can even add one).
 * An `agent:control` grant gives an Agent Endpoint `agents.control`, so the capability alone cannot keep a granted
 * Agent from handing over or taking back Sessions in other Projects; only the owner's own clients may call these.
 */
const ownerOnlyCommanderMethods: ReadonlySet<string> = new Set([
    'commander.conversations',
    'commander.session.handOver',
    'commander.session.takeBack',
]);

export const assertOwnerHandover = (context: CommandExecutionContext, method: string): void => {
    if (!ownerOnlyCommanderMethods.has(method)) return;
    if (context.principal.kind === 'desktop' || context.principal.kind === 'human-cli') return;
    throw new CaxriError('FORBIDDEN', 'Only the owner can hand Sessions to the Commander');
};
