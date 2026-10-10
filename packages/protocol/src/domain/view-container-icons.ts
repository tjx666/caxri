import type { ExtensionBuiltinIconId } from './views.js';

/**
 * The Lucide glyph (kebab-case name from https://lucide.dev/icons) each `builtin` view-container icon id renders as.
 *
 * Desktop's secondary-sidebar tab strip and the mobile Session segment bar both resolve a container's icon through this
 * one table, so a Project view carries the same glyph on both surfaces. Each surface then maps the glyph name to the
 * component from its own Lucide package (`lucide-react` or `lucide-react-native`). The table lives in the protocol
 * package because that is the only shared package the mobile runtime may import.
 *
 * It covers every id an extension manifest may declare plus the ids Caxri's own containers use.
 */
const BUILTIN_CONTAINER_GLYPHS = {
    'beaker': 'flask-conical',
    'files': 'files',
    'git-branch': 'git-branch',
    'inbox': 'inbox',
    'info': 'info',
    'scroll-text': 'scroll-text',
    'status': 'activity',
} as const satisfies Record<ExtensionBuiltinIconId, string> & Record<string, string>;

/**
 * Generic glyph for a container whose icon has no builtin mapping: an unknown builtin id, a `theme` icon, or an
 * extension image the reader cannot show (the mobile read surface drops `resource` icons). It must stay distinct from
 * every mapped glyph, Status's above all, so an unmapped container never passes for a known one.
 */
const FALLBACK_CONTAINER_GLYPH = 'package';

export type ViewContainerIconGlyph =
    | (typeof BUILTIN_CONTAINER_GLYPHS)[keyof typeof BUILTIN_CONTAINER_GLYPHS]
    | typeof FALLBACK_CONTAINER_GLYPH;

/**
 * A `Map` rather than an `in` lookup, so an id such as `constructor` cannot resolve to an `Object.prototype` member.
 */
const builtinContainerGlyphs: ReadonlyMap<string, ViewContainerIconGlyph> = new Map(
    Object.entries(BUILTIN_CONTAINER_GLYPHS),
);

/**
 * Resolves a view container's declared icon to the Lucide glyph every surface renders for it.
 */
export function viewContainerIconGlyph(
    icon: { readonly kind: string; readonly id?: string } | undefined,
): ViewContainerIconGlyph {
    if (icon?.kind !== 'builtin' || icon.id === undefined) return FALLBACK_CONTAINER_GLYPH;
    return builtinContainerGlyphs.get(icon.id) ?? FALLBACK_CONTAINER_GLYPH;
}
