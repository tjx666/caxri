import { extensionViewOperationResultSchemas, methods } from '@caxri/protocol';

import type {
    ExtensionViewOperation,
    ExtensionWorkspaceOperation,
} from '../../extension-host/protocol';

function invalidResult(operation: ExtensionViewOperation | ExtensionWorkspaceOperation): Error {
    return Object.assign(new Error(`Invalid workspace result for ${operation}`), {
        code: 'PROVIDER_FAILED',
    });
}

export function validatedServerWorkspaceResult(
    operation: ExtensionWorkspaceOperation,
    result: unknown,
): unknown {
    try {
        return methods[operation].result.parse(result);
    } catch {
        throw invalidResult(operation);
    }
}

export function validatedExtensionWorkspaceResult(
    operation: ExtensionViewOperation,
    result: unknown,
): unknown {
    try {
        return extensionViewOperationResultSchemas[operation].parse(result);
    } catch {
        throw invalidResult(operation);
    }
}
