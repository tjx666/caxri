import { describe, expect, it } from 'vitest';

import { describeCaxriMethod } from '../introspection';

describe('describeCaxriMethod', () => {
    it('serializes owner, effect, capabilities, idempotency, and JSON schemas for a command', () => {
        const description = describeCaxriMethod('project.list');
        expect(description).toMatchObject({
            method: 'project.list',
            owner: 'server',
            effect: 'read',
            idempotency: 'none',
            capabilities: ['projects.read'],
        });
        expect(description.paramsSchema).toBeTypeOf('object');
        expect(description.resultSchema).toBeTypeOf('object');
    });

    it('reflects a write command effect and capability set distinctly from a read command', () => {
        const description = describeCaxriMethod('session.rename');
        expect(description.effect).toBe('write');
        expect(description.idempotency).toBe('request');
        expect(description.capabilities).toEqual(['sessions.write']);
    });
});
