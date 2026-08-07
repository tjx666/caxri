import { describe, expect, it } from 'vitest';

import { resolveEditorLanguage } from './editor-language';

describe('resolveEditorLanguage', () => {
    it.each(['.gitignore', '.prettierignore', '.dockerignore', '.npmignore', 'local.ignore'])(
        'uses ignore syntax for %s',
        (filename) => {
            expect(resolveEditorLanguage(`caxri://session/session-1/project/${filename}`)).toBe(
                'ignore',
            );
        },
    );

    it.each(['.npmrc', '.yarnrc', '.babelrc', '.prettierrc'])(
        'uses rc syntax for %s',
        (filename) => {
            expect(resolveEditorLanguage(`caxri://session/session-1/project/${filename}`)).toBe(
                'rc',
            );
        },
    );

    it.each(['.env', '.env.local', 'development.env'])(
        'uses dotenv syntax for %s without relying on model inference',
        (filename) => {
            expect(resolveEditorLanguage(`caxri://session/session-1/project/${filename}`)).toBe(
                'caxri-dotenv',
            );
        },
    );

    it.each(['source.ts', 'settings.json', 'README', '.yarnrc.yml'])(
        'leaves Monaco inference unchanged for %s',
        (filename) => {
            expect(
                resolveEditorLanguage(`caxri://session/session-1/project/${filename}`),
            ).toBeUndefined();
        },
    );

    it('matches encoded model filenames without decoding path separators', () => {
        expect(resolveEditorLanguage('caxri://session/session-1/project/space%20name.ignore')).toBe(
            'ignore',
        );
    });
});
