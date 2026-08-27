import { describe, expect, it } from 'vitest';

import { pathBrowserMethods } from '../path-browser-contract';

describe('path browser contract', () => {
    it('keeps every browser lifecycle method owned by Desktop Main', () => {
        expect(Object.values(pathBrowserMethods).map(({ owner }) => owner)).toEqual([
            'desktop',
            'desktop',
            'desktop',
            'desktop',
            'desktop',
        ]);
    });

    it('strips raw filesystem paths from snapshots before they reach the Renderer', () => {
        const parsed = pathBrowserMethods['pathBrowser.start'].result.parse({
            browserId: 'a142df47-520c-496d-bafb-645c95da6501',
            canCreate: false,
            canGoParent: false,
            directoryLabel: '',
            entries: [
                {
                    id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                    kind: 'file',
                    name: 'example.ts',
                    path: '/private/authorized/example.ts',
                },
            ],
            rootLabel: 'Authorized Folder',
            truncated: false,
        });

        expect(parsed.entries).toEqual([
            {
                id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                kind: 'file',
                name: 'example.ts',
            },
        ]);
    });
});
