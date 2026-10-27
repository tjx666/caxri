import type { ServerRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MutationAdmission } from '../../mutation-admission';
import { invokeExtensionControlRequest } from '../control-requests';
import type { ExtensionService } from '../service';

const issuedIn = {
    kind: 'session',
    sessionId: 'session-1',
    workbenchRootProjectId: 'project-1',
} as const;

function harness() {
    const executeCommand = vi.fn<ExtensionService['executeCommand']>(() =>
        Promise.resolve({ executed: true }),
    );
    const viewOperation = vi.fn<ExtensionService['viewOperation']>(() => Promise.resolve(null));
    const service = { executeCommand, viewOperation } as unknown as ExtensionService;
    const admission = new MutationAdmission();
    const invoke = (request: ServerRequest) =>
        invokeExtensionControlRequest(
            request as Parameters<typeof invokeExtensionControlRequest>[0],
            service,
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
    /**
     * The command carries the Session it was issued in, and the service scopes it there, so a focus move to another
     * Session while it waits behind a mutation cannot redirect "Merge Pull Request for Current Branch".
     */
    it('runs an Extension command against the Session it was issued in', async () => {
        const { executeCommand, invoke } = harness();
        await expect(invoke(executeCommandRequest())).resolves.toEqual({ executed: true });
        expect(executeCommand).toHaveBeenCalledWith('publisher.merge', [], issuedIn);
    });

    it('keeps host stop draining until a running Extension command settles', async () => {
        const { admission, executeCommand, invoke } = harness();
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
        const { admission, executeCommand, invoke, viewOperation } = harness();
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
