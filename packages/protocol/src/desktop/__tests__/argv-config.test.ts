import { describe, expect, it } from 'vitest';

import { argvConfigChangesSchema, argvConfigSchema } from '../argv-config';

describe('argvConfigSchema', () => {
    it('requires explicit boolean boot values', () => {
        expect(
            argvConfigSchema.safeParse({ hardwareAcceleration: true, remoteDebugging: true })
                .success,
        ).toBe(true);
        expect(
            argvConfigSchema.safeParse({ hardwareAcceleration: false, remoteDebugging: false })
                .success,
        ).toBe(true);
        expect(argvConfigSchema.safeParse({}).success).toBe(false);
        expect(
            argvConfigSchema.safeParse({ hardwareAcceleration: 'yes', remoteDebugging: true })
                .success,
        ).toBe(false);
    });
});

describe('argvConfigChangesSchema', () => {
    it('makes every field optional so a partial patch is valid, including an empty patch', () => {
        expect(argvConfigChangesSchema.safeParse({}).success).toBe(true);
        expect(argvConfigChangesSchema.safeParse({ remoteDebugging: true }).success).toBe(true);
        expect(argvConfigChangesSchema.safeParse({ hardwareAcceleration: false }).success).toBe(
            true,
        );
    });

    it('still rejects a value of the wrong type for a present field', () => {
        expect(argvConfigChangesSchema.safeParse({ remoteDebugging: 'yes' }).success).toBe(false);
    });
});
