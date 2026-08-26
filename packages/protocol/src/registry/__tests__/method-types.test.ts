import { describe, expect, it } from 'vitest';

import type { CaxriRequest } from '../../index';
import {
    getMethodSpec,
    isCaxriMethod,
    isDesktopRequest,
    isMainRequest,
    isServerRequest,
} from '../../index';

describe('isCaxriMethod', () => {
    it('accepts a public method name and rejects an internal-only or unknown name', () => {
        expect(isCaxriMethod('project.list')).toBe(true);
        expect(isCaxriMethod('app.windowState.get')).toBe(false);
        expect(isCaxriMethod('not.a.method')).toBe(false);
    });
});

describe('owner narrowing guards', () => {
    it('routes a desktop-owned method through isDesktopRequest/isMainRequest only', () => {
        const request = { method: 'processExplorer.open', params: {} } as CaxriRequest;
        expect(isDesktopRequest(request)).toBe(true);
        expect(isMainRequest(request)).toBe(true);
        expect(isServerRequest(request)).toBe(false);
    });

    it('routes a server-owned method through isServerRequest only', () => {
        const request = { method: 'project.list', params: {} } as CaxriRequest;
        expect(isServerRequest(request)).toBe(true);
        expect(isDesktopRequest(request)).toBe(false);
        expect(isMainRequest(request)).toBe(false);
    });
});

describe('getMethodSpec', () => {
    it('resolves a public method, an internal-only method, and returns undefined otherwise', () => {
        expect(getMethodSpec('project.list')?.owner).toBe('host');
        expect(getMethodSpec('app.windowState.get')?.owner).toBe('host');
        expect(getMethodSpec('not.a.method')).toBeUndefined();
    });
});
