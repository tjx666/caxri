import type { ViewIcon } from '@shared/views';
import { describe, expect, it } from 'vitest';

import { isMonochromeSvgResource } from '../resource-icon';

describe('isMonochromeSvgResource', () => {
    it('keeps currentColor SVG contribution icons in the Renderer theme context', () => {
        const svgIcon: ViewIcon = {
            kind: 'resource',
            dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        };
        const pngIcon: ViewIcon = {
            kind: 'resource',
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        };

        expect(isMonochromeSvgResource(svgIcon)).toBe(true);
        expect(isMonochromeSvgResource(pngIcon)).toBe(false);
    });
});
