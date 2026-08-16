import { describe, expect, it } from 'vitest';

import { desktopRuntimeMethodIds, isDesktopRuntimeMethod } from '../desktop-runtime';

describe('isDesktopRuntimeMethod', () => {
    it('accepts every listed Desktop-authenticated Runtime method', () => {
        for (const method of desktopRuntimeMethodIds) {
            expect(isDesktopRuntimeMethod(method)).toBe(true);
        }
    });

    it('rejects a Runtime method absent from the Desktop-authenticated allowlist', () => {
        expect(isDesktopRuntimeMethod('files.read')).toBe(false);
        expect(isDesktopRuntimeMethod('not.a.method')).toBe(false);
    });

    it('never lists runtime.shutdown, keeping Desktop disconnection from stopping the Host Runtime', () => {
        expect(desktopRuntimeMethodIds).not.toContain('runtime.shutdown');
    });
});
