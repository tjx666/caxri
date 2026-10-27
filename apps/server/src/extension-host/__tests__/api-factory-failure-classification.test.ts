import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CancellationToken } from 'caxri';
import { CancellationTokenSource, EventEmitter, TreeItem } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    activateExtension,
    cancelTreeRequest,
    configureExtensions,
    executeExtensionCommand,
    extensionApiBinding,
    getTreeChildren,
} from '../api-factory';
import { isHostOriginatedError } from '../extension-error';
import type { ExtensionHostMessage } from '../protocol';
import { requestServerApi, settleApiReply } from '../server-api-request';
import { fixture, installExtensionFixture, registration } from './api-factory.fixture';

installExtensionFixture();

async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
    try {
        await request;
    } catch (error: unknown) {
        return error;
    }
    throw new Error('expected the request to reject');
}

/**
 * Issues one `git.summary` API call the way the bundled providers do, capturing the api-request message so the test can
 * settle it with Server Core's own reply.
 */
function issueSummaryCall(
    sent: ExtensionHostMessage[],
    token?: CancellationToken,
): Promise<unknown> {
    return requestServerApi(
        {
            apiToken: 'fixture-token-1',
            extensionId: 'publisher.fixture',
            generation: 1,
            assertCurrent: () => {},
            isApiTokenCurrent: () => true,
            send: (message) => sent.push(message),
        },
        {
            method: 'workspace.request',
            params: {
                operation: 'git.summary',
                arguments: { refresh: 0 },
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                },
            },
        },
        token,
    );
}

function expireIssuedCall(sent: ExtensionHostMessage[]): void {
    const issued = sent.find((message) => message.type === 'api-request');
    expect(issued).toBeDefined();
    settleApiReply(
        {
            id: issued!.id,
            ok: false,
            error: {
                code: 'GENERATION_EXPIRED',
                message: 'Active Project changed while the extension request was running',
            },
        },
        () => true,
    );
}

const viewContext = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchRootProjectId: 'project-1',
};

describe('Extension Host failure classification', () => {
    it('does not treat an extension-forged CANCELLED code as host-originated', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                // An extension provider can throw any code, including one that collides with a Caxri non-fault code.
                getChildren: () => {
                    throw Object.assign(new Error('boom'), { code: 'CANCELLED' });
                },
                getTreeItem: (element: string) => new TreeItem(element),
            },
        );
        let forgedRejection: unknown;
        try {
            await getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'forged-cancelled-request',
            });
        } catch (error) {
            forgedRejection = error;
        }
        // Code passthrough is unchanged: the caller still observes `code: 'CANCELLED'`.
        expect(forgedRejection).toMatchObject({ code: 'CANCELLED', message: 'boom' });
        // But origin, not the code string, decides classification: this was never minted through `hostError`.
        expect(isHostOriginatedError(forgedRejection)).toBe(false);
    });

    it("re-mints a tree provider's own CANCELLED once the host cancelled the request", async () => {
        configureExtensions([registration()]);
        const started = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: async (_element: unknown, token: CancellationToken) => {
                    started.resolve();
                    await gate.promise;
                    // The provider reports the host's cancellation back with its own plain code, like the Git
                    // extension's `assertNotCancelled`.
                    if (token.isCancellationRequested)
                        throw Object.assign(new Error('Tree read was cancelled'), {
                            code: 'CANCELLED',
                        });
                    return ['child'];
                },
                getTreeItem: (element: string) => new TreeItem(element),
            },
        );
        const request = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'own-cancelled-request',
        });
        await started.promise;
        expect(cancelTreeRequest('own-cancelled-request')).toEqual({ cancelled: true });
        gate.resolve();

        const rejection = await rejectionOf(request);
        expect(rejection).toMatchObject({ code: 'CANCELLED', message: 'Tree read was cancelled' });
        expect(isHostOriginatedError(rejection)).toBe(true);
    });

    it("re-mints a tree provider's own GENERATION_EXPIRED only after the host turned the instance over", async () => {
        configureExtensions([registration()]);
        const started = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: async () => {
                    started.resolve();
                    await gate.promise;
                    throw Object.assign(new Error('superseded'), { code: 'GENERATION_EXPIRED' });
                },
                getTreeItem: (element: string) => new TreeItem(element),
            },
        );
        const request = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'instance-turnover-request',
        });
        await started.promise;
        configureExtensions([registration(2)]);
        gate.resolve();

        const rejection = await rejectionOf(request);
        expect(rejection).toMatchObject({ code: 'GENERATION_EXPIRED', message: 'superseded' });
        expect(isHostOriginatedError(rejection)).toBe(true);
    });

    it.each([
        ['getChildren', true],
        ['getTreeItem', false],
    ])(
        "re-mints Server Core's Session-switch expiry that %s propagates from its API call",
        async (_stage, inChildren) => {
            // Mirrors extensions/status/src/project-status-provider.ts: the provider awaits a `caxri.*` call without a
            // catch. The scope must reach both provider calls, including the per-element `getTreeItem` inside
            // `Promise.all`, or the Status tree's Session switch returns to a warn fault.
            configureExtensions([registration()]);
            const sent: ExtensionHostMessage[] = [];
            extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
                'publisher.fixture.tree',
                {
                    getChildren: async () => {
                        if (inChildren) await issueSummaryCall(sent);
                        return ['child'];
                    },
                    getTreeItem: async (element: string) => {
                        if (!inChildren) await issueSummaryCall(sent);
                        return new TreeItem(element);
                    },
                },
            );
            const request = getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: `session-switch-${_stage}`,
                context: viewContext,
            });
            await expect.poll(() => sent.length).toBe(1);
            expireIssuedCall(sent);

            const rejection = await rejectionOf(request);
            expect(rejection).toMatchObject({ code: 'GENERATION_EXPIRED' });
            expect(isHostOriginatedError(rejection)).toBe(true);
        },
    );

    it('strips host origin from a host-minted error a contributed command re-throws', async () => {
        // Any extension can obtain a host-minted CANCELLED without a capability or a Server Core round trip by
        // cancelling its own token before a `caxri.*` call; re-throwing it from a command must not launder a real
        // command failure into a debug non-fault.
        const registered = registration();
        registered.manifest.contributes.commands = [
            { command: 'publisher.fixture.command', title: 'Fixture' },
        ];
        configureExtensions([registered]);
        const source = new CancellationTokenSource();
        source.cancel();
        const captured = await rejectionOf(issueSummaryCall([], source.token));
        expect(isHostOriginatedError(captured)).toBe(true);
        extensionApiBinding('fixture-token-1').api.commands.registerCommand(
            'publisher.fixture.command',
            () => {
                throw captured;
            },
        );

        const rejection = await rejectionOf(
            executeExtensionCommand({
                extensionId: 'publisher.fixture',
                generation: 1,
                commandId: 'publisher.fixture.command',
                arguments: [],
                context: viewContext,
            }),
        );
        expect(rejection).not.toBe(captured);
        expect(rejection).toMatchObject({ code: 'CANCELLED' });
        expect(isHostOriginatedError(rejection)).toBe(false);
    });

    it('strips host origin from a host-minted error activate() re-throws and keeps the activation wire code', async () => {
        await writeFile(
            join(fixture.extensionRoot, 'extension.mjs'),
            'export function activate() { throw globalThis.__caxriFixtureActivationError; }',
        );
        configureExtensions([registration()]);
        const source = new CancellationTokenSource();
        source.cancel();
        const captured = await rejectionOf(issueSummaryCall([], source.token));
        Object.assign(globalThis, { __caxriFixtureActivationError: captured });
        try {
            const rejection = await rejectionOf(activateExtension('publisher.fixture', 1));
            expect(rejection).not.toBe(captured);
            expect(rejection).toMatchObject({ code: 'CANCELLED' });
            expect(isHostOriginatedError(rejection)).toBe(false);

            // An uncoded activation failure keeps the ACTIVATION_FAILED wire code it always had.
            Object.assign(globalThis, { __caxriFixtureActivationError: new Error('boom') });
            configureExtensions([registration(2)]);
            await expect(activateExtension('publisher.fixture', 2)).rejects.toMatchObject({
                code: 'ACTIVATION_FAILED',
                message: 'boom',
            });

            // A non-Error throw keeps its text: the message is the only description that crosses the wire.
            Object.assign(globalThis, { __caxriFixtureActivationError: 'Cannot find module x' });
            configureExtensions([registration(3)]);
            await expect(activateExtension('publisher.fixture', 3)).rejects.toMatchObject({
                code: 'ACTIVATION_FAILED',
                message: 'Cannot find module x',
            });
        } finally {
            Reflect.deleteProperty(globalThis, '__caxriFixtureActivationError');
        }
    });

    it("keeps a command's own GENERATION_EXPIRED a fault when it disposed its own registration", async () => {
        // The registration Disposable is extension-owned state, like a tree provider's own refresh: disposing it from
        // inside `run()` must not manufacture the turnover that would launder a forged non-fault code.
        const registered = registration();
        registered.manifest.contributes.commands = [
            { command: 'publisher.fixture.command', title: 'Fixture' },
        ];
        configureExtensions([registered]);
        const { api } = extensionApiBinding('fixture-token-1');
        const subscription = api.commands.registerCommand('publisher.fixture.command', () => {
            subscription.dispose();
            throw Object.assign(new Error('real command failure'), { code: 'GENERATION_EXPIRED' });
        });

        const rejection = await rejectionOf(
            executeExtensionCommand({
                extensionId: 'publisher.fixture',
                generation: 1,
                commandId: 'publisher.fixture.command',
                arguments: [],
                context: viewContext,
            }),
        );
        expect(rejection).toMatchObject({
            code: 'GENERATION_EXPIRED',
            message: 'real command failure',
        });
        expect(isHostOriginatedError(rejection)).toBe(false);
    });

    it("keeps a tree provider's own GENERATION_EXPIRED a fault when it disposed its own registration", async () => {
        configureExtensions([registration()]);
        const { api } = extensionApiBinding('fixture-token-1');
        const subscription = api.views.registerTreeDataProvider('publisher.fixture.tree', {
            getChildren: () => {
                subscription.dispose();
                throw Object.assign(new Error('real tree failure'), { code: 'GENERATION_EXPIRED' });
            },
            getTreeItem: (element: string) => new TreeItem(element),
        });

        const rejection = await rejectionOf(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'self-disposed-tree-request',
                context: viewContext,
            }),
        );
        expect(rejection).toMatchObject({
            code: 'GENERATION_EXPIRED',
            message: 'real tree failure',
        });
        expect(isHostOriginatedError(rejection)).toBe(false);
    });

    it("keeps a tree provider's own GENERATION_EXPIRED a fault when only its own refresh fired", async () => {
        configureExtensions([registration()]);
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the public VS Code-compatible provider event.
        const changes = new EventEmitter<undefined>();
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                onDidChangeTreeData: changes.event,
                getChildren: () => {
                    // A provider can fire its own refresh before failing; that is extension-triggered state and
                    // must not launder a forged non-fault code.
                    changes.fire(undefined);
                    throw Object.assign(new Error('load failed'), { code: 'GENERATION_EXPIRED' });
                },
                getTreeItem: (element: string) => new TreeItem(element),
            },
        );

        const rejection = await rejectionOf(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'self-refresh-request',
            }),
        );
        expect(rejection).toMatchObject({ code: 'GENERATION_EXPIRED', message: 'load failed' });
        expect(isHostOriginatedError(rejection)).toBe(false);
        changes.dispose();
    });
});
