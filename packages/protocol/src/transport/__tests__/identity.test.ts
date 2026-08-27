import { describe, expect, it } from 'vitest';

import { protocolConnectionIdentitySchema, protocolFeatureSchema } from '../identity';

const opaqueIdentity = '0123456789abcdef0123456789abcdef';

describe('protocolConnectionIdentitySchema', () => {
    it('accepts the bounded identities carried by an authenticated connection', () => {
        expect(
            protocolConnectionIdentitySchema.parse({
                serverId: opaqueIdentity,
                bootId: opaqueIdentity,
                stateEpoch: opaqueIdentity,
                clientId: 'desktop:workbench-1',
                connectionId: opaqueIdentity,
            }),
        ).toMatchObject({ clientId: 'desktop:workbench-1' });
    });

    it('rejects malformed or unreviewed identity fields', () => {
        expect(() =>
            protocolConnectionIdentitySchema.parse({
                serverId: 'short',
                bootId: opaqueIdentity,
                stateEpoch: opaqueIdentity,
                clientId: 'desktop:workbench-1',
                connectionId: opaqueIdentity,
            }),
        ).toThrow();
        expect(() =>
            protocolConnectionIdentitySchema.parse({
                serverId: opaqueIdentity,
                bootId: opaqueIdentity,
                stateEpoch: opaqueIdentity,
                clientId: 'desktop:workbench-1',
                connectionId: opaqueIdentity,
                sourcePath: '/private/project',
            }),
        ).toThrow();
    });
});

describe('protocolFeatureSchema', () => {
    it('rejects unknown capabilities instead of silently enabling them', () => {
        expect(() => protocolFeatureSchema.parse('unreviewed-recovery-v1')).toThrow();
    });
});
