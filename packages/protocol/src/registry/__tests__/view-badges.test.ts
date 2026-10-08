import { describe, expect, it } from 'vitest';

import { viewBadgeSchema } from '../../domain/view-badges';
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
        expect(
            viewBadgeSchema.safeParse({ kind: 'count', count: 1, description: '1 change' }).success,
        ).toBe(true);
        for (const count of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
            expect(
                viewBadgeSchema.safeParse({ kind: 'count', count, description: 'Invalid' }).success,
            ).toBe(false);
        expect(
            viewBadgeSchema.safeParse({ kind: 'count', count: 1, description: 'x'.repeat(2049) })
                .success,
        ).toBe(false);
        expect(methods['viewContainers.viewOperation'].result.safeParse(null).success).toBe(true);
    });

    /**
     * Severity is the extension's only say in appearance, so the wire has to reject anything outside the three kinds:
     * including the pre-`kind` shape, whose `tone` let two views paint a container in two unrelated colors. A severity
     * has no tally at all: the Workbench draws a glyph for it, and a chip cannot hold a glyph and a digit at once, so a
     * `count` sent alongside one is stripped rather than carried to a renderer that would have to discard it anyway.
     */
    it('strips a count from a severity and rejects unknown or missing kinds', () => {
        for (const kind of ['error', 'warning'] as const) {
            expect(viewBadgeSchema.safeParse({ kind, description: 'Failing' }).success).toBe(true);
            expect(viewBadgeSchema.parse({ kind, count: 3, description: 'Failing' })).toEqual({
                kind,
                description: 'Failing',
            });
        }
        expect(viewBadgeSchema.safeParse({ kind: 'count', description: 'No tally' }).success).toBe(
            false,
        );
        expect(viewBadgeSchema.safeParse({ kind: 'danger', description: 'Unknown' }).success).toBe(
            false,
        );
        expect(
            viewBadgeSchema.safeParse({ count: 1, description: '1 change', tone: 'danger' })
                .success,
        ).toBe(false);
    });
});
