import type { ViewIcon } from '@shared/views';

/**
 * SVG contribution icons use `currentColor`; an `<img>` isolates that color from the app theme, so monochrome SVG
 * resources must render through a CSS mask instead.
 */
export function isMonochromeSvgResource(icon: ViewIcon): boolean {
    return icon.kind === 'resource' && icon.dataUrl.startsWith('data:image/svg+xml');
}
