import { describe, expect, it } from 'vitest';

import { editorExecutableCandidates, launchExternalEditor } from '../external-editor';

describe('editorExecutableCandidates', () => {
    it('uses a command containing a path separator as-is', () => {
        expect(editorExecutableCandidates('/usr/local/bin/code', '/usr/bin')).toEqual([
            '/usr/local/bin/code',
        ]);
    });

    it('searches PATH before the GUI-launch fallback directories', () => {
        expect(editorExecutableCandidates('code', '/usr/bin:/bin')).toEqual([
            '/usr/bin/code',
            '/bin/code',
            '/usr/local/bin/code',
            '/opt/homebrew/bin/code',
        ]);
    });

    it('deduplicates directories and tolerates a missing PATH', () => {
        expect(editorExecutableCandidates('code', '/usr/local/bin')).toEqual([
            '/usr/local/bin/code',
            '/opt/homebrew/bin/code',
        ]);
        expect(editorExecutableCandidates('code', undefined)).toEqual([
            '/usr/local/bin/code',
            '/opt/homebrew/bin/code',
        ]);
    });
});

describe('launchExternalEditor', () => {
    it('rejects when no editor command is configured', async () => {
        await expect(launchExternalEditor(null, '/tmp')).rejects.toThrow(
            /No external editor is configured/,
        );
        await expect(launchExternalEditor(' '.repeat(3), '/tmp')).rejects.toThrow(
            /No external editor is configured/,
        );
    });

    it('rejects with a settings hint when the command cannot be resolved', async () => {
        await expect(
            launchExternalEditor('caxri-test-missing-editor-binary', '/tmp'),
        ).rejects.toThrow(/was not found/);
    });
});
