import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import { expect, it, onTestFinished, vi } from 'vitest';

import { ControlServer } from '../control-server';
import { DelegationAccessRegistry } from '../delegation-access-registry';
import { acquireServerProfile } from '../profile';
import { createMemoryDelegationClientStore } from './credential-stores.fixture';

it('authenticates a scoped external client and rechecks revocation before cached replies', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-external-transport-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    const registry = DelegationAccessRegistry.open(createMemoryDelegationClientStore());
    const issued = await registry.create(
        { projectId: 'project', sessionId: 'session', callerProvider: 'codex' },
        60_000,
    );
    const invoke = vi.fn(() => ({
        delegationId: 'task',
        projectId: 'project',
        sessionId: 'session',
        provider: 'claude',
        status: 'interrupted',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    }));
    const server = new ControlServer({
        identity: lease.identity,
        desktopCredential: lease.desktopCredential,
        adapters: { server: { invoke } },
        authenticateDelegation: (credential) => registry.authenticate(credential),
        refreshContext: (context) =>
            context.principal.kind === 'delegation-client'
                ? registry.refresh(context.principal)
                : context,
    });
    const resources: { client?: ServerClient } = {};
    onTestFinished(async () => {
        resources.client?.close();
        await server.close();
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    await lease.publish(await server.start());
    const client = await ServerClient.connect(lease.manifest, 1000, {
        kind: 'delegation-client',
        clientId: issued.clientId,
        generation: issued.generation,
        token: issued.token,
    });
    resources.client = client;
    expect(client.welcome.capabilities).toEqual(['agents.delegate']);
    expect(client.welcome.commands).not.toContain('settings.delegation.import');
    expect(client.welcome.commands).not.toContain('agent.delegation.access.create');
    expect(client.welcome.commands).not.toContain('terminal.send');
    await client.requestWithId('same-request', 'agent.delegation.stop', { delegationId: 'task' });
    await registry.revoke(issued.clientId, issued.generation);
    await expect(
        client.requestWithId('same-request', 'agent.delegation.stop', { delegationId: 'task' }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
});

it('withholds an admitted response when access is revoked while waiting', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-external-wait-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    const registry = DelegationAccessRegistry.open(createMemoryDelegationClientStore());
    const issued = await registry.create(
        { projectId: 'project', sessionId: 'session', callerProvider: 'codex' },
        60_000,
    );
    const admitted = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown>();
    const server = new ControlServer({
        identity: lease.identity,
        desktopCredential: lease.desktopCredential,
        adapters: {
            server: {
                invoke: () => {
                    admitted.resolve();
                    return completed.promise;
                },
            },
        },
        authenticateDelegation: (credential) => registry.authenticate(credential),
        refreshContext: (context) =>
            context.principal.kind === 'delegation-client'
                ? registry.refresh(context.principal)
                : context,
    });
    const resources: { client?: ServerClient } = {};
    onTestFinished(async () => {
        completed.resolve(null);
        resources.client?.close();
        await server.close();
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    await lease.publish(await server.start());
    resources.client = await ServerClient.connect(lease.manifest, 1000, {
        kind: 'delegation-client',
        clientId: issued.clientId,
        generation: issued.generation,
        token: issued.token,
    });
    const waiting = resources.client.request('agent.delegation.wait', {
        delegationId: 'task',
        timeoutMs: 1000,
    });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admitted.promise;
    await registry.revoke(issued.clientId, issued.generation);
    completed.resolve({
        outcome: 'settled',
        receipt: {
            delegationId: 'task',
            projectId: 'project',
            sessionId: 'session',
            provider: 'claude',
            status: 'completed',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        },
    });
    await rejected;
});

/**
 * A wait's own deadline is authoritative. The CLI mirrors `--timeout` into the client's request deadline, and the
 * client starts that clock before the Server starts its wait, so a generic client timer would always fire first and
 * turn a normal "nothing ready yet" into a TIMEOUT error.
 */
it("returns the Server's wait timeout instead of racing it with the client deadline", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-external-wait-timeout-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    const registry = DelegationAccessRegistry.open(createMemoryDelegationClientStore());
    const issued = await registry.create(
        { projectId: 'project', sessionId: 'session', callerProvider: 'codex' },
        60_000,
    );
    const timeoutMs = 500;
    const server = new ControlServer({
        identity: lease.identity,
        desktopCredential: lease.desktopCredential,
        adapters: {
            server: {
                invoke: () =>
                    new Promise((resolve) => {
                        setTimeout(
                            () =>
                                resolve({
                                    outcome: 'timeout',
                                    receipt: {
                                        delegationId: 'task',
                                        projectId: 'project',
                                        sessionId: 'session',
                                        provider: 'claude',
                                        status: 'running',
                                        revision: 1,
                                        createdAt: 1,
                                        updatedAt: 1,
                                    },
                                }),
                            timeoutMs,
                        );
                    }),
            },
        },
        authenticateDelegation: (credential) => registry.authenticate(credential),
        refreshContext: (context) =>
            context.principal.kind === 'delegation-client'
                ? registry.refresh(context.principal)
                : context,
    });
    const resources: { client?: ServerClient } = {};
    onTestFinished(async () => {
        resources.client?.close();
        await server.close();
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    await lease.publish(await server.start());
    resources.client = await ServerClient.connect(lease.manifest, timeoutMs, {
        kind: 'delegation-client',
        clientId: issued.clientId,
        generation: issued.generation,
        token: issued.token,
    });

    await expect(
        resources.client.request('agent.delegation.wait', { delegationId: 'task', timeoutMs }),
    ).resolves.toMatchObject({ outcome: 'timeout', receipt: { status: 'running' } });
});
