import { describe, expect, it } from 'vitest';

import { commandPolicy } from '../method-spec';

describe('commandPolicy', () => {
    it('derives idempotency from effect: reads are none, writes and controls are request-scoped', () => {
        expect(commandPolicy('host', 'read').idempotency).toBe('none');
        expect(commandPolicy('host', 'write').idempotency).toBe('request');
        expect(commandPolicy('desktop', 'control').idempotency).toBe('request');
    });

    it('defaults required capabilities to the Desktop-owner capability', () => {
        expect(commandPolicy('desktop', 'read').requiredCapabilities).toEqual(['desktop']);
    });

    it('preserves an explicit, narrower capability list', () => {
        const policy = commandPolicy('host', 'write', ['projects.write']);
        expect(policy.requiredCapabilities).toEqual(['projects.write']);
        expect(policy.owner).toBe('host');
        expect(policy.effect).toBe('write');
    });
});
