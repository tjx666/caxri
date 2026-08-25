import type { ExtensionViewEventContext, RuntimeEvent } from '@caxri/protocol';

import type { HostRuntimeSupervisor } from '../runtime-supervisor';
import type { ExtensionService } from './service';
import { toExtensionViewEventContext } from './service-events';
import { extensionActiveContext } from './workspace-bridge';

type RuntimeBootstrapReader = Pick<HostRuntimeSupervisor, 'request'>;

export async function readActiveExtensionContext(
    supervisor: RuntimeBootstrapReader,
): Promise<ExtensionViewEventContext> {
    return toExtensionViewEventContext(
        extensionActiveContext(await supervisor.request('app.bootstrap')),
    );
}

/**
 * Routes Runtime invalidations into the Extension Host with the exact scope that produced them. The Host does not
 * synthesize an active-root scope for an unrelated Git or Status event, which would make a hidden view refresh the
 * wrong Session after a context switch.
 */
export async function routeExtensionRuntimeEvent(
    extensionService: ExtensionService | undefined,
    supervisor: RuntimeBootstrapReader,
    event: RuntimeEvent,
): Promise<void> {
    if (!extensionService) return;
    if (event.event === 'files.changed') {
        await extensionService.filesChanged(
            {
                kind: 'content',
                paths: event.payload.changes.map(({ path }) => path),
                ...((event.payload.overflow || event.payload.gitIgnoreRulesChanged) && {
                    overflow: true,
                }),
            },
            {
                kind: 'session',
                sessionId: event.payload.sessionId,
                workbenchProjectId: event.payload.workbenchProjectId,
            },
        );
        return;
    }
    if (event.event === 'files.operationChanged') {
        if (!event.payload.workbenchProjectId) return;
        await extensionService.filesChanged(
            { kind: 'operation' },
            {
                kind: 'session',
                sessionId: event.payload.sessionId,
                workbenchProjectId: event.payload.workbenchProjectId,
            },
        );
        return;
    }
    if (
        event.event !== 'projectStatus.changed' &&
        event.event !== 'git.changed' &&
        event.event !== 'state.changed'
    )
        return;
    const context = await readActiveExtensionContext(supervisor);
    if (event.event === 'projectStatus.changed') {
        if (context.kind !== 'session' || context.sessionId !== event.payload.sessionId) return;
        await extensionService.projectStatusChanged(context);
        return;
    }
    if (event.event === 'git.changed') {
        if (context.kind !== 'session' || !event.payload.sessionIds.includes(context.sessionId))
            return;
        await extensionService.gitChanged(context);
        return;
    }
    if (
        event.payload.kind === 'full' &&
        ['session.select', 'session.create', 'session.delete', 'session.workbenchRoot'].includes(
            event.payload.reason,
        )
    )
        await extensionService.activeContextChanged(context);
}
