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
