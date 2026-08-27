import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveViewContainerId } from '../resolution';

const catalog: ViewCatalogSnapshot = {
    revision: 1,
    containers: [
        {
            id: 'caxri.files',
            location: 'secondarySidebar',
            source: { kind: 'core' },
            title: 'Files',
            icon: { kind: 'builtin', id: 'files' },
            commandId: 'secondarySidebar.showFiles',
            lifecycle: 'core',
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

    it('keeps an explicitly selected failed extension reachable for error and Retry UI', () => {
        const failed: ViewCatalogSnapshot = {
            ...catalog,
            containers: catalog.containers.map((container) =>
                container.id === 'publisher.view'
                    ? {
                          ...container,
                          lifecycle: 'error' as const,
                          error: {
                              code: 'MANIFEST_INVALID' as const,
                              message: 'Extension manifest is invalid',
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
