import type { ExtensionViewEventContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

export function assertActiveViewContext(
    expected: ExtensionViewEventContext,
    active: { sessionId?: string; workbenchProjectId?: string },
): void {
    if (expected.kind === 'no-session' && !active.sessionId && !active.workbenchProjectId) return;
    if (
        expected.kind !== 'session' ||
        expected.sessionId !== active.sessionId ||
        expected.workbenchProjectId !== active.workbenchProjectId
    )
        throw new CaxriError('CANCELLED', 'Controlled view scope is no longer active');
}
