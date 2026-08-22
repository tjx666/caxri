import type { ViewCatalogSnapshot } from '@shared/views';
import { describe, expect, it } from 'vitest';

import { resolveViewContainerId } from '../resolution';

const catalog: ViewCatalogSnapshot = {
    revision: 1,
    containers: [
        {
            id: 'caxri.files',
            location: 'secondarySidebar',
            source: { kind: 'builtin' },
            title: 'Files',
            icon: { kind: 'builtin', id: 'files' },
            commandId: 'secondarySidebar.showFiles',
            lifecycle: 'builtin',
        },
        {
            id: 'publisher.view',
            location: 'secondarySidebar',
            source: { kind: 'extension', extensionId: 'publisher.extension' },
            title: 'Extension',
            icon: { kind: 'theme', id: 'beaker' },
            commandId: 'viewContainers.show.publisher.view',
            lifecycle: 'crashed',
        },
    ],
    views: [],
    commands: [],
    extensions: [],
};

describe('resolveViewContainerId', () => {
    it('derives a fallback without rewriting an unavailable desired ID', () => {
        const desired = 'publisher.view';
        expect(resolveViewContainerId(desired, 'secondarySidebar', catalog)).toBe('caxri.files');
        expect(desired).toBe('publisher.view');
    });

    it('rebinds the same desired ID when the extension becomes healthy', () => {
        const recovered: ViewCatalogSnapshot = {
            ...catalog,
            containers: catalog.containers.map((container) =>
                container.id === 'publisher.view'
                    ? { ...container, lifecycle: 'active' as const }
                    : container,
            ),
        };
        expect(resolveViewContainerId('publisher.view', 'secondarySidebar', recovered)).toBe(
            'publisher.view',
        );
    });

    it('keeps a failed desired container selected so its Retry action remains reachable', () => {
        const failed: ViewCatalogSnapshot = {
            ...catalog,
            containers: catalog.containers.map((container) =>
                container.id === 'publisher.view'
                    ? {
                          ...container,
                          lifecycle: 'error' as const,
                          error: {
                              code: 'ACTIVATION_FAILED',
                              message: 'Activation failed',
                          },
                      }
                    : container,
            ),
        };

        expect(resolveViewContainerId('publisher.view', 'secondarySidebar', failed)).toBe(
            'publisher.view',
        );
    });
});
