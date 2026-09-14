import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    completePathQuery,
    filterPathEntries,
    parentDirectoryWithinRoot,
    parsePathBrowserInput,
    pathBrowserCreateCandidate,
    pathBrowserEmptyMessage,
    pathBrowserKeyIntent,
    projectDirectoryPath,
} from './path-browser';

const entries: FileEntry[] = [
    { kind: 'directory', name: 'src', path: '/project/src' },
    { kind: 'directory', name: 'scripts', path: '/project/scripts' },
    { kind: 'file', name: 'README.md', path: '/project/README.md', size: 10 },
    { kind: 'file', name: 'package.json', path: '/project/package.json', size: 10 },
];

describe('path browser navigation', () => {
    it.each([
        ['~', 'home', '~/', ''],
        ['~/', 'home', '~/', ''],
        ['~/Documents/re', 'home', '~/Documents/', 're'],
        ['/', 'absolute', '/', ''],
        ['/Users/example/file.ts', 'absolute', '/Users/example/', 'file.ts'],
        ['..', 'parent', '../', ''],
        ['../', 'parent', '../', ''],
        ['../src/target.ts', 'parent', '../src/', 'target.ts'],
        ['src/nested/', 'relative', 'src/nested/', ''],
        ['README.md', 'filter', '', 'README.md'],
    ] as const)(
        'splits %s into a browsable directory and final filter',
        (value, kind, directoryPart, filter) => {
            expect(parsePathBrowserInput(value)).toMatchObject({ directoryPart, filter, kind });
        },
    );

    it('rejects unsupported shell expansion forms', () => {
        expect(() => parsePathBrowserInput('$HOME/file.ts')).toThrow(
            'Shell path expansion is not supported',
        );
        expect(() => parsePathBrowserInput('~other/file.ts')).toThrow(
            'Only current-user ~/ paths are supported',
        );
    });

    it('filters only the current directory without reordering Runtime results', () => {
        expect(filterPathEntries(entries, 's')).toEqual([entries[0], entries[1], entries[3]]);
        expect(filterPathEntries(entries, 'read')).toEqual([entries[2]]);
        expect(filterPathEntries(entries, '')).toEqual(entries);
    });

    it('completes the final segment while preserving relative, Home, and absolute directories', () => {
        expect(
            completePathQuery([{ kind: 'symlink', linkKind: 'directory', name: 'linked' }], 'li'),
        ).toBe('linked/');
        expect(completePathQuery([{ kind: 'file', name: 'README.md' }], 'src/re')).toBe(
            'src/README.md',
        );
        expect(completePathQuery([{ kind: 'directory', name: 'Documents' }], '~/Do')).toBe(
            '~/Documents/',
        );
        expect(completePathQuery([{ kind: 'directory', name: 'code' }], '/Users/tj/co')).toBe(
            '/Users/tj/code/',
        );
        expect(completePathQuery(entries, 's')).toBeUndefined();
        expect(completePathQuery([entries[2]], 'read', true)).toBeUndefined();
    });

    it('never completes the input with a Project-search row from another directory', () => {
        expect(
            completePathQuery([{ kind: 'file', name: 'target.ts' }], 'target', false, 'directory'),
        ).toBe('target.ts');
        expect(
            completePathQuery(
                [{ kind: 'file', name: 'target.ts' }],
                'target',
                false,
                'projectSearch',
            ),
        ).toBeUndefined();
    });

    it('distinguishes an exhausted scan from an authoritative empty result', () => {
        expect(pathBrowserEmptyMessage(0, true)).toBe(
            'No match in the scanned items. Refine or open a narrower folder.',
        );
        expect(pathBrowserEmptyMessage(0, false)).toBe('No matching file or folder.');
        expect(pathBrowserEmptyMessage(1, true)).toBeUndefined();
        expect(pathBrowserEmptyMessage(0, true, 'projectSearch')).toBe(
            'No match in the scanned files. Refine the name.',
        );
    });

    it('returns to a parent without ever crossing the Project root', () => {
        expect(parentDirectoryWithinRoot('/project', '/project/src/nested')).toBe('/project/src');
        expect(parentDirectoryWithinRoot('/project', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/project')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/outside')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project')).toBe('/');
    });

    it('renders the current Project directory as a trailing-slash absolute path', () => {
        expect(projectDirectoryPath('/project', '')).toBe('/project/');
        expect(projectDirectoryPath('/project', 'src/nested/')).toBe('/project/src/nested/');
        expect(projectDirectoryPath('/', '')).toBe('/');
        expect(projectDirectoryPath('/', 'Users/tj/')).toBe('/Users/tj/');
    });

    it('offers Project-local file and folder creation only', () => {
        expect(pathBrowserCreateCandidate('project', 'notes.md', 0, false, true)).toEqual({
            kind: 'file',
            name: 'notes.md',
        });
        expect(pathBrowserCreateCandidate('project', 'drafts/', 0, false, true)).toEqual({
            kind: 'directory',
            name: 'drafts',
        });
        expect(pathBrowserCreateCandidate('free', 'notes.md', 0, false, true)).toBeUndefined();
    });

    it('never offers to create while results may still contain an existing entry', () => {
        expect(pathBrowserCreateCandidate('project', 'README.md', 1, false, true)).toBeUndefined();
        expect(pathBrowserCreateCandidate('project', 'missing', 0, true, true)).toBeUndefined();
        expect(pathBrowserCreateCandidate('project', '', 0, false, true)).toBeUndefined();
        expect(pathBrowserCreateCandidate('project', 'README.md', 0, false, false)).toBeUndefined();
    });

    it('rejects creation names that are not one Project-local segment', () => {
        expect(pathBrowserCreateCandidate('project', '.', 0, false, true)).toBeUndefined();
        expect(pathBrowserCreateCandidate('project', '..', 0, false, true)).toBeUndefined();
        expect(
            pathBrowserCreateCandidate('project', 'nested/name', 0, false, true),
        ).toBeUndefined();
        expect(pathBrowserCreateCandidate('project', '/', 0, false, true)).toBeUndefined();
    });
});

describe('path browser keyboard intent', () => {
    const keyIntent = (
        overrides: Partial<Parameters<typeof pathBrowserKeyIntent>[0]>,
    ): ReturnType<typeof pathBrowserKeyIntent> =>
        pathBrowserKeyIntent({
            entryCount: 1,
            input: '',
            isComposing: false,
            key: 'Enter',
            mode: 'project',
            selectedKind: 'directory',
            selectionEnd: 0,
            selectionStart: 0,
            ...overrides,
        });

    it.each(['Backspace', 'Delete'])('%s detaches an empty Project anchor at the start', (key) => {
        expect(keyIntent({ key })).toEqual({ kind: 'detach-project' });
    });

    it('does not detach free mode, non-empty input, a selection, or composing input', () => {
        expect(keyIntent({ key: 'Backspace', mode: 'free' })).toBeUndefined();
        expect(
            keyIntent({ input: 'src', key: 'Backspace', selectionEnd: 3, selectionStart: 3 }),
        ).toBeUndefined();
        expect(keyIntent({ key: 'Backspace', selectionEnd: 1 })).toBeUndefined();
        expect(keyIntent({ isComposing: true, key: 'Backspace' })).toBeUndefined();
    });

    it('keeps Left and Right as caret movement inside text', () => {
        expect(
            keyIntent({
                input: '/Users/tj',
                key: 'ArrowLeft',
                selectionEnd: 5,
                selectionStart: 5,
            }),
        ).toBeUndefined();
        expect(
            keyIntent({
                input: '/Users/tj',
                key: 'ArrowRight',
                selectionEnd: 5,
                selectionStart: 5,
            }),
        ).toBeUndefined();
    });

    it('uses boundary arrows for directory navigation', () => {
        expect(keyIntent({ key: 'ArrowLeft' })).toEqual({ kind: 'parent' });
        expect(
            keyIntent({
                input: 'src',
                key: 'ArrowRight',
                selectionEnd: 3,
                selectionStart: 3,
            }),
        ).toEqual({ kind: 'enter-directory' });
        expect(keyIntent({ key: 'ArrowRight', selectedKind: 'file' })).toBeUndefined();
    });

    it('maps close, list movement, completion, and acceptance to explicit commands', () => {
        expect(keyIntent({ key: 'Escape' })).toEqual({ kind: 'close' });
        expect(keyIntent({ key: 'ArrowDown' })).toEqual({ delta: 1, kind: 'move-selection' });
        expect(keyIntent({ key: 'ArrowUp' })).toEqual({ delta: -1, kind: 'move-selection' });
        expect(keyIntent({ key: 'Tab' })).toEqual({ kind: 'complete' });
        expect(keyIntent({ key: 'Enter' })).toEqual({ kind: 'accept' });
        expect(keyIntent({ entryCount: 0, key: 'ArrowDown' })).toBeUndefined();
    });
});
