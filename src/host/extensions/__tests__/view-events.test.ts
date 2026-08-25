import type { ViewDescriptor } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ExtensionHostMessage } from '../../../shared/extension-host-protocol';
import { projectExtensionHostViewEvent } from '../service-events';
import { isExtensionViewChangeCompatible } from '../view-events';

describe('extension controlled view events', () => {
    it('keeps actions inside their declared generic view kind', () => {
        expect(
            isExtensionViewChangeCompatible(
                { kind: 'resource-explorer' },
                { kind: 'create', itemKind: 'file' },
            ),
        ).toBe(true);
        expect(
            isExtensionViewChangeCompatible(
                { kind: 'resource-explorer' },
                { kind: 'mode', mode: 'commit' },
            ),
        ).toBe(false);
        expect(
            isExtensionViewChangeCompatible(
                { kind: 'source-control' },
                { kind: 'mode', mode: 'pull-request' },
            ),
        ).toBe(true);
        expect(
            isExtensionViewChangeCompatible({ kind: 'source-control' }, { kind: 'search' }),
        ).toBe(false);
        expect(isExtensionViewChangeCompatible({ kind: 'tree' }, { kind: 'content' })).toBe(false);
    });

    it('preserves the typed no-session scope when projecting a tree refresh', () => {
        const event = {
            type: 'event',
            event: 'treeChanged',
            extensionId: 'publisher.fixture',
            generation: 3,
            viewId: 'publisher.fixture.tree',
            eventId: 'tree-event-1',
            context: { kind: 'no-session' },
        } satisfies Extract<ExtensionHostMessage, { type: 'event' }>;
        const descriptor: ViewDescriptor = {
            id: 'publisher.fixture.tree',
            containerId: 'publisher.fixture',
            source: { kind: 'extension', extensionId: 'publisher.fixture' },
            title: 'Fixture',
            viewKind: { kind: 'tree' },
        };

        expect(projectExtensionHostViewEvent(event, 3, descriptor)).toEqual({
            eventName: 'treeChanged',
            detail: {
                viewId: 'publisher.fixture.tree',
                eventId: 'tree-event-1',
                extensionGeneration: 3,
                context: { kind: 'no-session' },
            },
        });
    });
});
