import type { ServerRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MutationAdmission } from '../../mutation-admission';
import { invokeExtensionControlRequest } from '../control-requests';
import type { ExtensionService } from '../service';

const issuedIn = {
    kind: 'session',
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
} as const;

function harness(active: { sessionId: string; workbenchProjectId: string }) {
    const executeCommand = vi.fn<ExtensionService['executeCommand']>(() =>
        Promise.resolve({ executed: true }),
    );
    const viewOperation = vi.fn<ExtensionService['viewOperation']>(() => Promise.resolve(null));
    const service = { executeCommand, viewOperation } as unknown as ExtensionService;
    const domainService = {
        request: vi.fn(() =>
            Promise.resolve({ projectIds: [active.workbenchProjectId], ...active }),
        ),
    };
    const admission = new MutationAdmission();
    const invoke = (request: ServerRequest) =>
        invokeExtensionControlRequest(
            request as Parameters<typeof invokeExtensionControlRequest>[0],
            service,
            domainService as never,
            admission,
        );
    return { admission, executeCommand, invoke, viewOperation };
}

function executeCommandRequest(): ServerRequest {
    return {
        method: 'viewContainers.executeCommand',
        params: { commandId: 'publisher.merge', arguments: [], context: issuedIn },
    };
}

function viewOperationRequest(operation: 'source.action' | 'source.snapshot'): ServerRequest {
    return {
        method: 'viewContainers.viewOperation',
        params: {
            viewId: 'publisher.git.sourceControl',
            requestId: 'view-request',
            operation,
            arguments:
                operation === 'source.action'
                    ? { actionId: 'action-1', revision: '1' }
                    : { refresh: 0 },
            context: issuedIn,
        },
    } as ServerRequest;
}

describe('invokeExtensionControlRequest', () => {
    it('runs an Extension command against the Session it was issued in', async () => {
        const { executeCommand, invoke } = harness({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        await expect(invoke(executeCommandRequest())).resolves.toEqual({ executed: true });
        expect(executeCommand).toHaveBeenCalledWith('publisher.merge', [], issuedIn);
    });

    /**
     * A command can wait behind another repository mutation while a Session switch passes it, so it must not start
     * against the Session the user switched to: "Merge Pull Request for Current Branch" would merge that Session's PR.
     */
    it('cancels an Extension command once its Session is no longer active', async () => {
        const { executeCommand, invoke } = harness({
            sessionId: 'session-2',
            workbenchProjectId: 'project-1',
        });
        await expect(invoke(executeCommandRequest())).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(executeCommand).not.toHaveBeenCalled();
    });

    it('keeps host stop draining until a running Extension command settles', async () => {
        const { admission, executeCommand, invoke } = harness({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        const release = Promise.withResolvers<{ executed: true }>();
        executeCommand.mockReturnValueOnce(release.promise);
        const running = invoke(executeCommandRequest());
        await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
        admission.close();
        let isDrained = false;
        const drained = (async () => {
            await admission.waitForDrain();
            isDrained = true;
        })();
        await Promise.resolve();
        expect(isDrained).toBe(false);
        release.resolve({ executed: true });
        await running;
        await drained;
        expect(isDrained).toBe(true);
    });

    it('refuses Extension mutations but serves view reads once host stop closed admission', async () => {
        const { admission, executeCommand, invoke, viewOperation } = harness({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        admission.close();
        await expect(invoke(executeCommandRequest())).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        await expect(invoke(viewOperationRequest('source.action'))).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(executeCommand).not.toHaveBeenCalled();
        await expect(invoke(viewOperationRequest('source.snapshot'))).resolves.toBeNull();
        expect(viewOperation).toHaveBeenCalledOnce();
    });
});
