import { describe, expect, it } from 'vitest';

import { workbenchCoreContributions } from '../../registry/core-contributions';
import { viewContainerIconGlyph } from '../view-container-icons';
import { extensionBuiltinIconIdSchema } from '../views';

const builtin = (id: string) => ({ kind: 'builtin', id });

describe('viewContainerIconGlyph', () => {
    it('maps every builtin container icon id to its Lucide glyph', () => {
        expect(viewContainerIconGlyph(builtin('beaker'))).toBe('flask-conical');
        expect(viewContainerIconGlyph(builtin('files'))).toBe('files');
        expect(viewContainerIconGlyph(builtin('git-branch'))).toBe('git-branch');
        expect(viewContainerIconGlyph(builtin('inbox'))).toBe('inbox');
        expect(viewContainerIconGlyph(builtin('info'))).toBe('info');
        expect(viewContainerIconGlyph(builtin('scroll-text'))).toBe('scroll-text');
        expect(viewContainerIconGlyph(builtin('status'))).toBe('activity');
    });

    it('gives each id an extension may declare its own glyph, distinct from the fallback', () => {
        const glyphs = extensionBuiltinIconIdSchema.options.map((id) =>
            viewContainerIconGlyph(builtin(id)),
        );
        expect(new Set(glyphs).size).toBe(glyphs.length);
        expect(glyphs).not.toContain(viewContainerIconGlyph(undefined));
    });

    it('maps the core Files container rather than falling back', () => {
        for (const { container } of workbenchCoreContributions)
            expect(viewContainerIconGlyph(container.icon)).not.toBe(
                viewContainerIconGlyph(undefined),
            );
    });

    it('falls back to one generic glyph, distinct from Status, for any icon it cannot map', () => {
        const unmappable = [
            undefined,
            builtin('arbitrary-lucide-name'),
            // A prototype key must not resolve to `Object.prototype` members.
            builtin('constructor'),
            // Only `builtin` ids name a container glyph; a theme id of the same name does not.
            { kind: 'theme', id: 'status' },
            { kind: 'resource', dataUrl: 'data:image/svg+xml;base64,' },
        ];
        for (const icon of unmappable) expect(viewContainerIconGlyph(icon)).toBe('package');
        expect(viewContainerIconGlyph(builtin('status'))).not.toBe('package');
    });
});
