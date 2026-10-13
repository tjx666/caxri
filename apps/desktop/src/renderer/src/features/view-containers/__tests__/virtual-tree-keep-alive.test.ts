import { describe, expect, it, vi } from 'vitest';

import { ignoreHiddenViewportRect, keepAliveMeasuredSize } from '../virtual-tree-keep-alive';

describe('ignoreHiddenViewportRect', () => {
    it('keeps the last shown viewport when a hidden container reports zero height', () => {
        const callback = vi.fn();
        const observe = ignoreHiddenViewportRect(callback);
        observe({ height: 420, width: 280 });
        observe({ height: 0, width: 0 });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenLastCalledWith({ height: 420, width: 280 });
    });

    it('still reports a real resize after the container is shown again', () => {
        const callback = vi.fn();
        const observe = ignoreHiddenViewportRect(callback);
        observe({ height: 0, width: 0 });
        observe({ height: 360, width: 280 });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenLastCalledWith({ height: 360, width: 280 });
    });
});

describe('keepAliveMeasuredSize', () => {
    it('keeps a measured row size while the container is hidden', () => {
        expect(keepAliveMeasuredSize(0, 44)).toBe(44);
    });

    it('accepts real measurements and a first zero measurement with no previous size', () => {
        expect(keepAliveMeasuredSize(52, 44)).toBe(52);
        expect(keepAliveMeasuredSize(0, undefined)).toBe(0);
    });
});
