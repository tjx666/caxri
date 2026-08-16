import { describe, expect, it } from 'vitest';

import { isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '../renderer-error';

describe('isRendererErrorKind', () => {
    it('accepts the declared renderer fault kinds', () => {
        expect(isRendererErrorKind('page-exception')).toBe(true);
        expect(isRendererErrorKind('unhandled-rejection')).toBe(true);
    });

    it('rejects anything outside the declared kind set, including similarly shaped strings', () => {
        expect(isRendererErrorKind('page-crash')).toBe(false);
        expect(isRendererErrorKind('')).toBe(false);
        expect(isRendererErrorKind(null)).toBe(false);
        expect(isRendererErrorKind(undefined)).toBe(false);
        expect(isRendererErrorKind(42)).toBe(false);
    });
});

describe('RENDERER_ERROR_CHANNELS', () => {
    it('keeps the process-explorer and workbench channel names distinct', () => {
        expect(RENDERER_ERROR_CHANNELS.processExplorer).not.toBe(RENDERER_ERROR_CHANNELS.workbench);
    });
});
