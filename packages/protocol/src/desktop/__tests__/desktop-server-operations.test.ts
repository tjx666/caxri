import { describe, expect, it } from 'vitest';

import { CAXRI_PROTOCOL_VERSION, requestEnvelopeSchema } from '../../index';
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

    it('keeps the host Trash move behind Main, off the Renderer request allowlist', () => {
        expect(isDesktopServerOperation('files.trashOnHost')).toBe(true);
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'r1',
                method: 'files.trashOnHost',
                params: { sessionId: 'session-1', path: '/project/a.md', device: '1', inode: '2' },
            }).success,
        ).toBe(false);
    });
});
