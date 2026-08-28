import { z } from 'zod';

import { canceledResultSchema, identifierSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

export const MAX_PATH_BROWSER_ENTRIES = 200;

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const entryTarget = z.object({ kind: z.literal('entry'), entryId: identifierSchema });
const inputTarget = z.object({
    kind: z.literal('input'),
    value: z.string().min(1).max(4_096),
});
const parentTarget = z.object({ kind: z.literal('parent') });
const navigationTarget = z.discriminatedUnion('kind', [entryTarget, inputTarget, parentTarget]);
const pathBrowserEntry = z.object({
    id: identifierSchema,
    kind: z.enum(['directory', 'file', 'symlink']),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative().optional(),
});
const pathBrowserSnapshot = z.object({
    browserId: identifierSchema,
    canCreate: z.boolean(),
    canGoParent: z.boolean(),
    directoryLabel: z.string().max(4_096),
    entries: z.array(pathBrowserEntry).max(MAX_PATH_BROWSER_ENTRIES),
    rootLabel: z.string().min(1).max(1_024),
    truncated: z.boolean(),
});
const pathBrowserOpened = z.object({ opened: z.literal(true) });
const pathBrowserNavigationResult = z.union([
    canceledResultSchema,
    pathBrowserOpened,
    pathBrowserSnapshot,
]);

/**
 * Main owns path-browser locations and entry IDs so the Renderer cannot expand an opaque folder grant into raw
 * filesystem access. Only the user's typed path crosses this boundary.
 */
export const pathBrowserMethods = {
    'pathBrowser.start': {
        ...desktopControl,
        params: z.object({ sessionId: identifierSchema }),
        result: pathBrowserSnapshot,
    },
    'pathBrowser.browse': {
        ...desktopRead,
        params: z.object({ browserId: identifierSchema, query: z.string().max(255) }),
        result: pathBrowserSnapshot,
    },
    'pathBrowser.navigate': {
        ...desktopControl,
        params: z.object({ browserId: identifierSchema, target: navigationTarget }),
        result: pathBrowserNavigationResult,
    },
    'pathBrowser.open': {
        ...desktopWrite,
        params: z.object({ browserId: identifierSchema, entryId: identifierSchema }),
        result: z.union([canceledResultSchema, pathBrowserOpened]),
    },
    'pathBrowser.close': {
        ...desktopControl,
        params: z.object({ browserId: identifierSchema }),
        result: z.null(),
    },
} as const;
