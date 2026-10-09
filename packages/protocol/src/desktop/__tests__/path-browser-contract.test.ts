import { describe, expect, it } from 'vitest';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../configuration/settings-spec';
import { pathBrowserMethods, pathBrowserServerMethods } from '../path-browser-contract';

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

    it('keeps the subpath fallback lookup on Server Core and bounds its suffix', () => {
        const method = pathBrowserServerMethods['files.locateDirectory'];
        expect(method.owner).toBe('server');
        expect(method.params.safeParse({ sessionId: 'session-1', suffix: '' }).success).toBe(false);
        expect(
            method.params.safeParse({ sessionId: 'session-1', suffix: 'packages/bank' }).success,
        ).toBe(true);
    });

    it('returns one shallowest located directory instead of a raw match list', () => {
        const schema = pathBrowserServerMethods['files.locateDirectory'].result;
        expect(schema.safeParse({ path: null, truncated: true }).success).toBe(true);
        expect(schema.safeParse({ path: '/x', truncated: false }).success).toBe(true);
        expect(schema.safeParse({ paths: [], truncated: false }).success).toBe(false);
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
                    source: 'directory',
                },
            ],
            input: '',
            mode: 'project',
            projectSearch: 'skipped',
            rootLabel: 'Authorized Folder',
            truncated: false,
        });

        // The lookup that produced the row survives; the filesystem path it came from does not.
        expect(parsed.entries).toEqual([
            {
                id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                kind: 'file',
                name: 'example.ts',
                source: 'directory',
            },
        ]);
    });

    it('carries display-only symlink target metadata alongside the opaque entry id', () => {
        const parsed = pathBrowserMethods['pathBrowser.start'].result.parse({
            browserId: 'a142df47-520c-496d-bafb-645c95da6501',
            canCreate: false,
            canGoParent: false,
            directoryLabel: '',
            entries: [
                {
                    id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                    kind: 'symlink',
                    linkKind: 'directory',
                    linkTarget: 'real-dir',
                    name: 'link-to-dir',
                    source: 'directory',
                },
                {
                    id: '0ceead35-aa64-43c0-9e32-4cc16ec5342c',
                    kind: 'file',
                    name: 'plain.ts',
                    source: 'projectSearch',
                },
            ],
            input: '',
            mode: 'project',
            projectSearch: 'complete',
            truncated: false,
        });

        expect(parsed.entries[0]).toEqual({
            id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
            kind: 'symlink',
            linkKind: 'directory',
            linkTarget: 'real-dir',
            name: 'link-to-dir',
            source: 'directory',
        });
        // The fields stay optional, so an unprobed link and every non-link entry omit them entirely. `source` is not
        // optional: both lookups arrive in one list, so a row that cannot say where it came from cannot be placed.
        expect(parsed.entries[1]).toEqual({
            id: '0ceead35-aa64-43c0-9e32-4cc16ec5342c',
            kind: 'file',
            name: 'plain.ts',
            source: 'projectSearch',
        });
        const schema = pathBrowserMethods['pathBrowser.start'].result;
        expect(
            schema.safeParse({
                browserId: 'a142df47-520c-496d-bafb-645c95da6501',
                canCreate: false,
                canGoParent: false,
                directoryLabel: '',
                entries: [
                    {
                        id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                        kind: 'symlink',
                        linkKind: 'elsewhere',
                        name: 'link-to-dir',
                        source: 'directory',
                    },
                ],
                input: '',
                mode: 'project',
                projectSearch: 'skipped',
                truncated: false,
            }).success,
        ).toBe(false);
    });

    it('accepts a bounded full browse input and requires its explicit mode', () => {
        const schema = pathBrowserMethods['pathBrowser.browse'].params;
        const base = {
            browserId: 'a142df47-520c-496d-bafb-645c95da6501',
            mode: 'free' as const,
        };

        expect(schema.safeParse({ ...base, input: 'x'.repeat(4_096) }).success).toBe(true);
        expect(schema.safeParse({ ...base, input: 'x'.repeat(4_097) }).success).toBe(false);
        expect(schema.safeParse({ browserId: base.browserId, input: '~/' }).success).toBe(false);
    });

    it('models leaving the Project anchor as navigation, not a raw path target', () => {
        const schema = pathBrowserMethods['pathBrowser.navigate'].params;
        const browserId = 'a142df47-520c-496d-bafb-645c95da6501';

        expect(schema.safeParse({ browserId, target: { kind: 'detachProject' } }).success).toBe(
            true,
        );
        expect(
            schema.safeParse({ browserId, target: { kind: 'input', value: '/private' } }).success,
        ).toBe(false);
    });

    it('returns either a Project open or one bounded read-only external document', () => {
        const schema = pathBrowserMethods['pathBrowser.open'].result;
        expect(schema.safeParse({ opened: true, kind: 'project' }).success).toBe(true);
        expect(
            schema.safeParse({
                opened: true,
                kind: 'external',
                document: {
                    id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                    name: 'example.ts',
                    displayPath: '/private/example.ts',
                    content: 'export {};',
                    mtimeMs: 1,
                    size: 10,
                },
            }).success,
        ).toBe(true);
        expect(
            schema.safeParse({
                opened: true,
                kind: 'external',
                document: {
                    id: '0ceead35-aa64-43c0-9e32-4cc16ec5342b',
                    name: 'example.ts',
                    displayPath: '/private/example.ts',
                    content: 'x'.repeat(MAX_CONFIGURABLE_FILE_BYTES + 1),
                    mtimeMs: 1,
                    size: MAX_CONFIGURABLE_FILE_BYTES + 1,
                },
            }).success,
        ).toBe(false);
    });
});
