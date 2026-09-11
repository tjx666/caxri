import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { DelegationAccessRegistry } from '../delegation-access-registry';

it('persists only token digests and enforces expiry and revocation on existing identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-external-access-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'clients.json');
    let now = 1000;
    const registry = await DelegationAccessRegistry.open(directory, path, () => now);
    const issued = await registry.create(
        { projectId: 'project', sessionId: 'session', callerProvider: 'codex' },
        60_000,
    );
    expect(await readFile(path, 'utf8')).not.toContain(issued.token);
    expect(JSON.stringify(registry.list())).not.toContain(issued.token);
    const context = registry.authenticate(issued);
    expect(context.capabilities).toEqual(['agents.delegate']);
    expect(context.principal).toMatchObject({
        kind: 'delegation-client',
        projectIds: ['project'],
        sessionId: 'session',
        callerProvider: 'codex',
    });
    expect(() => registry.authenticate({ ...issued, token: 'wrong' })).toThrow();
    const reopened = await DelegationAccessRegistry.open(directory, path, () => now);
    expect(reopened.authenticate(issued)).toEqual(context);
    await reopened.revoke(issued.clientId, issued.generation);
    expect(() => reopened.authenticate(issued)).toThrow();
    if (context.principal.kind !== 'delegation-client') throw new Error('Wrong principal');
    const principal = context.principal;
    expect(() => reopened.refresh(principal)).toThrow();
    const afterRevocation = await DelegationAccessRegistry.open(directory, path, () => now);
    expect(() => afterRevocation.authenticate(issued)).toThrow();
    const next = await afterRevocation.create(
        { projectId: 'project', sessionId: 'session', callerProvider: 'grok' },
        60_000,
    );
    now += 60_000;
    expect(() => afterRevocation.authenticate(next)).toThrow();
});
