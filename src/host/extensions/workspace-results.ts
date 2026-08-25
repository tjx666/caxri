import { extensionViewOperationResultSchemas, methods } from '@caxri/protocol';

import type { ExtensionWorkspaceOperation } from '../../shared/extension-host-protocol';

function invalidResult(operation: ExtensionWorkspaceOperation): Error {
    return Object.assign(new Error(`Invalid workspace result for ${operation}`), {
        code: 'PROVIDER_FAILED',
    });
}

export function validatedRuntimeWorkspaceResult(
    operation: ExtensionWorkspaceOperation,
    result: unknown,
): unknown {
    try {
        if (operation === 'files.reveal') {
            if (result !== null) throw invalidResult(operation);
            return null;
        }
        return methods[operation].result.parse(result);
    } catch {
        throw invalidResult(operation);
    }
}

export function validatedExtensionWorkspaceResult(
    operation: ExtensionWorkspaceOperation,
    result: unknown,
): unknown {
    try {
        return extensionViewOperationResultSchemas[operation].parse(result);
    } catch {
        throw invalidResult(operation);
    }
}

/**
 * Removes Runtime-only filesystem identities before a durable operation crosses into the public API.
 */
export function projectFileOperation(operation: Record<string, unknown>): Record<string, unknown> {
    const projected = { ...operation };
    if (typeof projected.expectedResult === 'object' && projected.expectedResult !== null) {
        const expectedResult = { ...projected.expectedResult };
        Reflect.deleteProperty(expectedResult, 'device');
        Reflect.deleteProperty(expectedResult, 'inode');
        projected.expectedResult = expectedResult;
    }
    return projected;
}
