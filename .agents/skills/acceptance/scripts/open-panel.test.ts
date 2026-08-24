import { realpath } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseOpenPanelOptions, resolveFixturePath } from './open-panel';

describe('Acceptance macOS open panel wrapper', () => {
    it('requires exact semantic title, button, and bounded path operation inputs', () => {
        expect(
            parseOpenPanelOptions([
                'choose-path',
                '--title',
                'Import Theme',
                '--button',
                'Open',
                '--path',
                'fixture.json',
                '--timeout-ms',
                '30000',
            ]),
        ).toEqual({
            button: 'Open',
            command: 'choose-path',
            path: 'fixture.json',
            timeoutMs: 30000,
            title: 'Import Theme',
        });
        expect(() =>
            parseOpenPanelOptions([
                'click',
                '--title',
                'Import Theme',
                '--button',
                'Open',
                '--path',
                'fixture.json',
            ]),
        ).toThrow('--path is valid only for choose-path');
    });

    it('rejects duplicate target options', () => {
        expect(() =>
            parseOpenPanelOptions([
                'inspect',
                '--title',
                'Import Theme',
                '--button',
                'Open',
                '--button',
                'Cancel',
            ]),
        ).toThrow('Duplicate option: --button');
        expect(() =>
            parseOpenPanelOptions(['click', '--title', 'Import Theme', '--button', 'Cancel']),
        ).toThrow('--button must be the semantic Open action');
    });

    it('rejects hidden fixture paths that the semantic file browser cannot expose', async () => {
        await expect(resolveFixturePath('.gitignore')).rejects.toThrow(
            'stage chooser fixtures under test-results/acceptance-native',
        );
    });

    it('accepts a real non-hidden fixture inside the Acceptance worktree', async () => {
        await expect(resolveFixturePath('package.json')).resolves.toBe(
            await realpath('package.json'),
        );
    });
});
