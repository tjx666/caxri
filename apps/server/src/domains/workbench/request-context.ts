import type { WorkbenchRequestContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * Revalidates a Server-attested extension request at the Server execution boundary. This check is synchronous so the
 * selected Workbench Root cannot change between validation and the domain handler capturing its authorized root.
 */
export function validateWorkbenchRequestContext(
    database: CaxriDatabase,
    context: WorkbenchRequestContext,
): void {
    const binding = database.getSessionWorkbenchBinding(context.sessionId);
    if (!binding || binding.workbenchRootProjectId !== context.workbenchRootProjectId)
        throw new CaxriError(
            'CONFLICT',
            'Workbench Root changed before the extension operation started',
        );
}
