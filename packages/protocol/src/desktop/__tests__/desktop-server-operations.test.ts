import { describe, expect, it } from 'vitest';

import { desktopServerOperationIds, isDesktopServerOperation } from '../desktop-server-operations';

describe('isDesktopServerOperation', () => {
    it('accepts every listed Desktop-authenticated Server operation', () => {
        for (const method of desktopServerOperationIds) {
            expect(isDesktopServerOperation(method)).toBe(true);
        }
    });

    it('rejects a Server operation absent from the Desktop-authenticated allowlist', () => {
        expect(isDesktopServerOperation('files.read')).toBe(false);
        expect(isDesktopServerOperation('not.a.method')).toBe(false);
    });

    it('allows Main to resolve a Terminal Home link through the authenticated Server route', () => {
        expect(desktopServerOperationIds).toContain('terminal.fileLink.resolve');
        expect(isDesktopServerOperation('terminal.fileLink.resolve')).toBe(true);
    });
});
