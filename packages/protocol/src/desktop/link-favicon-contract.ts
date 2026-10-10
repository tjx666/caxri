import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * A site icon is read at most 32 KiB, so its base64 data URL stays inside this bound.
 */
export const MAX_LINK_FAVICON_DATA_URL_LENGTH = 48 * 1024;

export const linkFaviconDesktopMethods = {
    /**
     * The site icon a transcript shows ahead of a web link. Main fetches it through Chromium's network stack (the
     * system proxy and HTTP cache apply) rather than the Renderer loading it as an `<img>`: a site without one answers
     * 404, and Chromium reports every failed image load as a console error. An HTTPS origin only; the result has no
     * `dataUrl` when the site has no usable icon.
     */
    'links.favicon': {
        ...commandPolicy('desktop', 'read'),
        params: z.strictObject({
            origin: z
                .string()
                .max(2048)
                .regex(/^https:\/\/[^\s#/?@]+$/u),
        }),
        result: z.strictObject({
            dataUrl: z.string().max(MAX_LINK_FAVICON_DATA_URL_LENGTH).optional(),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
