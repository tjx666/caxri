import { getIconForFile, getIconForFolder } from '@yutengjing/vscode-icons';
import { describe, expect, it } from 'vitest';

import { fileIconSvg, resolveFileIconId } from '../file-icon';
import {
    FILE_ICON_EXTENSIONS,
    FILE_ICON_NAMES,
    FILE_ICON_SVGS,
    FOLDER_ICON_NAMES,
} from '../file-icons.generated';

const file = (name: string) => ({ kind: 'file' as const, name });
const folder = (name: string) => ({ kind: 'directory' as const, name });

describe('resolveFileIconId', () => {
    it('matches the Desktop icon for common names', () => {
        for (const name of ['main.ts', 'App.tsx', 'package.json', 'README.md', '.gitignore'])
            expect(`${resolveFileIconId(file(name))}.svg`).toBe(getIconForFile(name));
        for (const name of ['src', '.github', 'node_modules'])
            expect(`${resolveFileIconId(folder(name))}.svg`).toBe(getIconForFolder(name));
    });

    it('prefers the longest extension suffix', () => {
        expect(`${resolveFileIconId(file('parser.test.ts'))}.svg`).toBe(
            getIconForFile('parser.test.ts'),
        );
        expect(resolveFileIconId(file('parser.test.ts'))).not.toBe(
            resolveFileIconId(file('parser.ts')),
        );
    });

    it('falls back to defaults for unknown names', () => {
        expect(resolveFileIconId(file('notes.unknownext'))).toBe('default_file');
        expect(resolveFileIconId(folder('holiday-photos'))).toBe('default_folder');
    });

    it('resolves symlinks by target and keeps broken links neutral', () => {
        expect(
            resolveFileIconId({
                kind: 'symlink',
                linkKind: 'file',
                linkTarget: '/var/log/app.json',
                name: 'current',
            }),
        ).toBe(resolveFileIconId(file('app.json')));
        expect(resolveFileIconId({ kind: 'symlink', linkKind: 'directory', name: 'src' })).toBe(
            resolveFileIconId(folder('src')),
        );
        expect(resolveFileIconId({ kind: 'symlink', linkKind: 'broken', name: 'main.ts' })).toBe(
            'default_file',
        );
    });
});

describe('generated file icon table', () => {
    it('stays in sync with the vscode-icons lookup Desktop uses', () => {
        for (const [extension, id] of Object.entries(FILE_ICON_EXTENSIONS))
            expect(getIconForFile(`file.${extension}`)).toBe(`${id}.svg`);
        for (const [name, id] of Object.entries(FILE_ICON_NAMES))
            expect(getIconForFile(name)).toBe(`${id}.svg`);
        for (const [name, id] of Object.entries(FOLDER_ICON_NAMES))
            expect(getIconForFolder(name)).toBe(`${id}.svg`);
    });

    it('embeds every referenced icon', () => {
        const ids = [
            ...Object.values(FILE_ICON_EXTENSIONS),
            ...Object.values(FILE_ICON_NAMES),
            ...Object.values(FOLDER_ICON_NAMES),
        ];
        for (const id of ids) expect(FILE_ICON_SVGS[id]).toMatch(/^<svg/u);
        expect(fileIconSvg('missing')).toBe(FILE_ICON_SVGS.default_file);
    });
});
