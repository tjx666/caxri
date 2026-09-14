import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '../theme';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function importSource(fileName: string, source: string): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-malformed-'));
    temporaryDirectories.push(directory);
    const path = join(directory, fileName);
    await writeFile(path, source);
    return importTheme(path, draculaTheme);
}

async function expectRejection(fileName: string, source: string): Promise<CaxriError> {
    let rejection: CaxriError | undefined;
    try {
        await importSource(fileName, source);
    } catch (error_) {
        rejection = error_ as CaxriError;
    }
    expect(rejection, `${fileName} should have been rejected`).toBeDefined();
    return rejection!;
}

/**
 * Companion to `./theme.test.ts`, which covers the import limits (size, symlink, FIFO) and the mapping fidelity of a
 * well-formed file. This file owns the opposite half: a file that parses to nothing useful. Both failure shapes are
 * covered per format, because closing one leaves the other open (issue #750) — a parser throw becomes an uncategorized
 * `INTERNAL` fault with a stack in the Server log, while a well-formed but empty document throws nothing and silently
 * replaces the user's theme with a renamed Dracula clone.
 */
describe('theme import rejects documents with no theme data', () => {
    it.each([
        ['sample.yaml', '', 'empty'],
        ['sample.yaml', '   \n\n# only a comment\n', 'comment-only'],
        ['sample.yaml', '---\n', 'document marker only'],
        ['sample.yaml', '- one\n- two\n', 'sequence root'],
        ['sample.yaml', '"scalar"\n', 'scalar root'],
        ['sample.json', '', 'empty'],
        ['sample.json', 'null', 'null root'],
        ['sample.json', '5', 'scalar root'],
        ['sample.json', '[]', 'array root'],
        ['sample.json', '{}', 'object with no keys'],
        ['sample.json', '{ "colors": ', 'truncated syntax'],
        ['sample.itermcolors', '', 'empty'],
        ['sample.itermcolors', '<plist version="1.0"></plist>', 'plist with no root dict'],
        ['sample.itermcolors', '<plist version="1.0"><dict/></plist>', 'empty root dict'],
    ])('rejects a %s that is %s (%s)', async (fileName, source) => {
        const error = await expectRejection(fileName, source);
        expect(error.code).toBe('VALIDATION');
        expect(error.message).toMatch(/theme file (could not be parsed|is empty or has no theme)/);
    });

    /**
     * `.itermcolors` had no behavior coverage at all before this file, so pin the mapper on a document that does carry
     * data: the rejection cases above would otherwise be satisfied by a parser that always throws.
     */
    it('still imports an iTerm2 plist that defines colors', async () => {
        const theme = (await importSource(
            'sample.itermcolors',
            `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Background Color</key>
  <dict>
    <key>Red Component</key><real>0</real>
    <key>Green Component</key><real>0</real>
    <key>Blue Component</key><real>0</real>
  </dict>
  <key>Ansi 1 Color</key>
  <dict>
    <key>Red Component</key><real>1</real>
    <key>Green Component</key><real>0</real>
    <key>Blue Component</key><real>0</real>
  </dict>
</dict></plist>
`,
        )) as { terminal: { background: string; red: string }; source: string };

        expect(theme.source).toBe('iterm2');
        expect(theme.terminal.background).toBe('#000000');
        expect(theme.terminal.red).toBe('#ff0000');
    });
});
