import { describe, expect, it } from 'vitest';

import { displayFolderPath, folderBreadcrumbs, resolveFolderInput } from '../folder-picker';

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
