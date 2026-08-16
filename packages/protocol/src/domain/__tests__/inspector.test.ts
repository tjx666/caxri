import { describe, expect, it } from 'vitest';

import { inspectorModeRegistrations, inspectorModeSchema } from '../inspector.js';

describe('inspectorModeSchema', () => {
    it('accepts every mode declared in the registration list', () => {
        for (const registration of inspectorModeRegistrations) {
            expect(inspectorModeSchema.safeParse(registration.mode).success).toBe(true);
        }
    });

    it('rejects a mode that is not registered', () => {
        expect(inspectorModeSchema.safeParse('unknown-mode').success).toBe(false);
    });

    it('derives its enum values one-to-one from the registration list', () => {
        expect(inspectorModeSchema.options).toEqual(
            inspectorModeRegistrations.map((registration) => registration.mode),
        );
    });
});
