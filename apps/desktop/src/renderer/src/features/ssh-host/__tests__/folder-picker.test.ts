import { describe, expect, it } from 'vitest';

import {
    displayFolderPath,
    folderBreadcrumbs,
    folderInputText,
    folderInputView,
    folderKeyAction,
    folderTargetIndex,
    moveFolderSelection,
    resolveFolderInput,
} from '../folder-picker';

const home = '/home/dev';

describe('resolveFolderInput', () => {
    it('expands ~ against the SSH Host home and normalizes absolute paths', () => {
        expect(resolveFolderInput('~', home)).toBe('/home/dev');
        expect(resolveFolderInput(' ~/code/app/ ', home)).toBe('/home/dev/code/app');
        expect(resolveFolderInput('/srv//data/', home)).toBe('/srv/data');
        expect(resolveFolderInput('/', home)).toBe('/');
    });

    it('refuses a relative path or another user home', () => {
        expect(resolveFolderInput('code', home)).toBeUndefined();
        expect(resolveFolderInput('~other/code', home)).toBeUndefined();
    });
});

describe('folderBreadcrumbs', () => {
    it('starts at ~ inside the home folder', () => {
        expect(folderBreadcrumbs('/home/dev/code/app', home)).toEqual([
            { label: '~', path: '/home/dev' },
            { label: 'code', path: '/home/dev/code' },
            { label: 'app', path: '/home/dev/code/app' },
        ]);
    });

    it('starts at / elsewhere, including a sibling that only shares a prefix with home', () => {
        expect(folderBreadcrumbs('/home/developer', home)).toEqual([
            { label: '/', path: '/' },
            { label: 'home', path: '/home' },
            { label: 'developer', path: '/home/developer' },
        ]);
        expect(folderBreadcrumbs('/', home)).toEqual([{ label: '/', path: '/' }]);
    });

    it('shows the path ~-relative inside home', () => {
        expect(displayFolderPath('/home/dev/code', home)).toBe('~/code');
        expect(displayFolderPath('/home/dev', home)).toBe('~');
        expect(displayFolderPath('/srv/data', home)).toBe('/srv/data');
    });
});

describe('folder field text', () => {
    it('shows the current folder with a trailing slash so typing filters its subfolders', () => {
        expect(folderInputText('/home/dev/code', home)).toBe('~/code/');
        expect(folderInputText('/srv/data', home)).toBe('/srv/data/');
        expect(folderInputText('/', home)).toBe('/');
    });

    it('splits the text into the folder to list and the filter', () => {
        expect(folderInputView('~/code/ap', home)).toEqual({
            directory: '/home/dev/code',
            filter: 'ap',
        });
        expect(folderInputView('/srv/', home)).toEqual({ directory: '/srv', filter: '' });
        expect(folderInputView('/srv', home)).toEqual({ directory: '/', filter: 'srv' });
        expect(folderInputView('app', home)).toEqual({ directory: undefined, filter: 'app' });
        expect(folderInputView('~other/x', home)).toEqual({ directory: undefined, filter: '' });
    });
});

describe('folder selection', () => {
    const entries = [{ name: 'app' }, { name: 'app2' }, { name: 'lib' }];

    it('targets nothing until the user filters or chooses a row', () => {
        expect(folderTargetIndex(entries, '', undefined)).toBeUndefined();
        expect(folderTargetIndex(entries, 'ap', undefined)).toBe(0);
        expect(folderTargetIndex([{ name: 'app2' }, { name: 'app' }], 'app', undefined)).toBe(1);
        expect(folderTargetIndex(entries, '', 2)).toBe(2);
        expect(folderTargetIndex(entries, '', 9)).toBe(2);
        expect(folderTargetIndex([], 'x', undefined)).toBeUndefined();
    });

    it('moves with wrap-around from either end', () => {
        expect(moveFolderSelection(3, undefined, 1)).toBe(0);
        expect(moveFolderSelection(3, undefined, -1)).toBe(2);
        expect(moveFolderSelection(3, 2, 1)).toBe(0);
        expect(moveFolderSelection(3, 0, -1)).toBe(2);
    });
});

describe('folderKeyAction', () => {
    const base = {
        entryCount: 3,
        hasTarget: true,
        input: '~/code/ap',
        isComposing: false,
        selectionEnd: 9,
        selectionStart: 9,
    };

    it('reads the keys the way Path browser does', () => {
        expect(folderKeyAction({ ...base, key: 'ArrowDown' })).toEqual({ delta: 1, kind: 'move' });
        expect(folderKeyAction({ ...base, key: 'ArrowUp' })).toEqual({ delta: -1, kind: 'move' });
        expect(folderKeyAction({ ...base, key: 'Tab' })).toEqual({ kind: 'complete' });
        expect(folderKeyAction({ ...base, key: 'ArrowRight' })).toEqual({ kind: 'open-target' });
        expect(folderKeyAction({ ...base, key: 'Enter' })).toEqual({ kind: 'open-target' });
        expect(
            folderKeyAction({ ...base, key: 'ArrowLeft', selectionEnd: 0, selectionStart: 0 }),
        ).toEqual({
            kind: 'parent',
        });
    });

    it('submits the typed path when there is no target and lets Tab and Escape through', () => {
        const idle = { ...base, hasTarget: false };
        expect(folderKeyAction({ ...idle, key: 'Enter' })).toEqual({ kind: 'submit-path' });
        expect(folderKeyAction({ ...idle, key: 'Tab' })).toBeUndefined();
        expect(folderKeyAction({ ...base, key: 'Escape' })).toBeUndefined();
        expect(
            folderKeyAction({
                ...base,
                key: 'Backspace',
                input: '',
                selectionEnd: 0,
                selectionStart: 0,
            }),
        ).toBeUndefined();
        expect(folderKeyAction({ ...base, isComposing: true, key: 'Enter' })).toBeUndefined();
    });
});
