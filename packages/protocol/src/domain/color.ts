import { z } from 'zod';

/**
 * `#RRGGBB`, optionally with an `AA` alpha suffix. The only color literal shape any Caxri wire payload accepts: theme
 * token imports and the icon tint an external system supplies for its own content both validate against it, so a
 * malformed value is rejected at the process boundary rather than reaching a `style` attribute.
 */
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
