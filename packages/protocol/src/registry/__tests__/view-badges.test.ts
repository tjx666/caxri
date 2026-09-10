import { describe, expect, it } from 'vitest';

import { viewBadgeSchema } from '../../domain/views';
import { methods } from '../methods';

describe('badge protocol', () => {
    it('requires a scoped read with empty arguments', () => {
        const request = {
            viewId: 'fixture.view',
            requestId: 'badge-1',
            operation: 'badge.snapshot',
            context: { kind: 'session', sessionId: 'session-a', workbenchProjectId: 'project-a' },
            arguments: {},
        };
        const schema = methods['viewContainers.viewOperation'].params;
        expect(schema.safeParse(request).success).toBe(true);
        expect(schema.safeParse({ ...request, arguments: { rootPath: '/outside' } }).success).toBe(
            false,
        );
        expect(
            schema.safeParse({ ...request, context: { kind: 'session', sessionId: 'session-a' } })
                .success,
        ).toBe(false);
    });

    it('bounds counts and descriptions and permits a serializable empty badge', () => {
        expect(viewBadgeSchema.safeParse({ count: 1, description: '1 change' }).success).toBe(true);
        for (const count of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
            expect(viewBadgeSchema.safeParse({ count, description: 'Invalid' }).success).toBe(
                false,
            );
        expect(viewBadgeSchema.safeParse({ count: 1, description: 'x'.repeat(2049) }).success).toBe(
            false,
        );
        expect(methods['viewContainers.viewOperation'].result.safeParse(null).success).toBe(true);
    });
});
