import { describe, expect, it } from 'vitest';

import { resolveEditorLanguage, resolveRegisteredEditorLanguage } from '../editor-language';

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

    it.each(['flow.mmd', 'Sequence.MERMAID'])('uses Mermaid syntax for %s', (filename) => {
        expect(resolveEditorLanguage(`caxri://session/session-1/project/${filename}`)).toBe(
            'mermaid',
        );
    });

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

describe('resolveRegisteredEditorLanguage', () => {
    const registrations = [
        { id: 'typescript', extensions: ['.ts', '.tsx'] },
        { id: 'dockerfile', filenames: ['Dockerfile'] },
        { id: 'templated-typescript', extensions: ['.generated.ts'] },
    ];

    it('resolves built-in Monaco languages for custom diff model URIs', () => {
        expect(
            resolveRegisteredEditorLanguage(
                'caxri://git-diff/session/repository/modified/src/App.tsx',
                registrations,
            ),
        ).toBe('typescript');
        expect(
            resolveRegisteredEditorLanguage(
                'caxri://git-diff/session/repository/modified/Dockerfile',
                registrations,
            ),
        ).toBe('dockerfile');
    });

    it('prefers custom language rules and the longest registered extension', () => {
        expect(
            resolveRegisteredEditorLanguage(
                'caxri://git-diff/session/repository/modified/.env.local',
                registrations,
            ),
        ).toBe('caxri-dotenv');
        expect(
            resolveRegisteredEditorLanguage(
                'caxri://git-diff/session/repository/modified/schema.generated.ts',
                registrations,
            ),
        ).toBe('templated-typescript');
    });
});
