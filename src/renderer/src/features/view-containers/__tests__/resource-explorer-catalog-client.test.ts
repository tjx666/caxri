import type { ViewCatalogSnapshot } from '@shared/views';
import { describe, expect, it } from 'vitest';

import { availableResourceExplorerViewId } from '../resource-explorer-catalog-client';

function catalog(lifecycle: 'crashed' | 'discovered' | 'error'): ViewCatalogSnapshot {
    return {
        revision: 1,
        containers: [],
        commands: [],
        extensions: [
            {
                id: 'publisher.files',
                version: '1.0.0',
                generation: 1,
                lifecycle,
                ...(lifecycle === 'crashed' && {
                    error: {
                        code: 'EXTENSION_HOST_UNAVAILABLE' as const,
                        message: 'Extension Host is restarting',
                    },
                }),
            },
        ],
        views: [
            {
                id: 'publisher.files.explorer',
                containerId: 'publisher.files',
                source: { kind: 'extension', extensionId: 'publisher.files' },
                title: 'Files',
                viewKind: { kind: 'resource-explorer' },
            },
        ],
    };
}

describe('availableResourceExplorerViewId', () => {
    it('waits while the provider is absent or its Extension Host is unavailable', () => {
        expect(availableResourceExplorerViewId({ extensions: [], views: [] })).toBeUndefined();
        expect(availableResourceExplorerViewId(catalog('crashed'))).toBeUndefined();
        expect(availableResourceExplorerViewId(catalog('error'))).toBeUndefined();
    });

    it('selects a manifest-contributed provider as soon as its lifecycle is available', () => {
        expect(availableResourceExplorerViewId(catalog('discovered'))).toBe(
            'publisher.files.explorer',
        );
    });
});
