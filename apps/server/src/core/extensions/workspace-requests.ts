import type { ExtensionCapability } from '@caxri/protocol';
import { methods } from '@caxri/protocol';

import type { ExtensionWorkspaceOperation } from '../../extension-host/protocol';

/**
 * Admission policy for Extension Workspace API requests: which Git capability an operation needs and how its
 * extension-supplied arguments are validated and stamped with Server-owned fields before reaching a domain method.
 */
const readWorkspaceOperations = new Set<ExtensionWorkspaceOperation>([
    'git.commits',
    'git.commitDetails',
    'git.pullRequestChanges',
    'git.remoteHost',
    'git.summary',
]);

export function isReadWorkspaceOperation(operation: ExtensionWorkspaceOperation): boolean {
    return readWorkspaceOperations.has(operation);
}

export function workspaceCapability(operation: ExtensionWorkspaceOperation): ExtensionCapability {
    const access = isReadWorkspaceOperation(operation) ? 'read' : 'write';
    return `git.${access}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function workspaceParameters(
    operation: ExtensionWorkspaceOperation,
    arguments_: unknown,
    sessionId: string,
): unknown {
    if (!isRecord(arguments_))
        throw Object.assign(new Error('Extension workspace arguments must be an object'), {
            code: 'PROVIDER_FAILED',
        });
    try {
        /**
         * `requester` is Server-stamped, never extension-supplied: it attributes `git.summary` log volume to the
         * Extension Host entry point regardless of what the extension put in its arguments.
         */
        return methods[operation].params.parse({
            ...arguments_,
            sessionId,
            ...(operation === 'git.summary' && { requester: 'extension' }),
        });
    } catch {
        throw Object.assign(new Error(`Invalid Extension API arguments for ${operation}`), {
            code: 'PROVIDER_FAILED',
        });
    }
}
