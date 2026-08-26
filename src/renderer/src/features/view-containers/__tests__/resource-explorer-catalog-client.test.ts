import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { availableResourceExplorerViewId } from '../resource-explorer-catalog-client';

function catalog(source: 'core' | 'extension'): ViewCatalogSnapshot {
    return {
        revision: 1,
        containers: [],
        commands: [],
        extensions:
            source === 'extension'
                ? [
                      {
                          id: 'publisher.files',
                          version: '1.0.0',
                          generation: 1,
                          lifecycle: 'active',
                      },
                  ]
                : [],
        views: [
            {
                id: 'publisher.files.explorer',
                containerId: 'publisher.files',
                source:
                    source === 'core'
                        ? { kind: 'core' }
                        : { kind: 'extension', extensionId: 'publisher.files' },
                title: 'Files',
                viewKind: { kind: 'resource-explorer' },
            },
        ],
    };
}

describe('availableResourceExplorerViewId', () => {
    it('selects the generic Core Resource Explorer without a product id lookup', () => {
        expect(availableResourceExplorerViewId(catalog('core'))).toBe('publisher.files.explorer');
    });

    it('never treats an extension-owned Resource Explorer as Files Core', () => {
        expect(availableResourceExplorerViewId(catalog('extension'))).toBeUndefined();
        expect(availableResourceExplorerViewId({ extensions: [], views: [] })).toBeUndefined();
    });
});
