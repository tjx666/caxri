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
    // The document goes last so it never lands in the reported test name: several cases span lines, and a case name is
    // the wrong place to reproduce the contents of a user's file.
    it.each([
        ['sample.yaml', 'empty', ''],
        ['sample.yaml', 'comment-only', '   \n\n# only a comment\n'],
        ['sample.yaml', 'document marker only', '---\n'],
        ['sample.yaml', 'a sequence root', '- one\n- two\n'],
        ['sample.yaml', 'a scalar root', '"scalar"\n'],
        ['sample.json', 'empty', ''],
        ['sample.json', 'a null root', 'null'],
        ['sample.json', 'a scalar root', '5'],
        ['sample.json', 'an array root', '[]'],
        ['sample.json', 'an object with no keys', '{}'],
        ['sample.json', 'truncated syntax', '{ "colors": '],
        ['sample.itermcolors', 'empty', ''],
        ['sample.itermcolors', 'a plist with no root dict', '<plist version="1.0"></plist>'],
        ['sample.itermcolors', 'an empty root dict', '<plist version="1.0"><dict/></plist>'],
    ])('rejects a %s that is %s', async (fileName, _label, source) => {
        const error = await expectRejection(fileName, source);
        expect(error.code).toBe('VALIDATION');
        expect(error.message).toMatch(/theme file (could not be parsed|is empty or has no theme)/);
    });

    /**
     * A VS Code theme may name a same-directory parent with `include`, so the parent is a second untrusted document on
     * the same import. It used to be parsed bare, which made a broken parent the exact `INTERNAL` fault this issue is
     * about, and a parent that parsed to an array was reported as `Theme include must be a file in the same directory.`
     * — pointing at the one thing that was not wrong.
     */
    it.each([
        ['broken syntax', '{ "colors": '],
        ['an array root', '[]'],
    ])('rejects an include parent with %s', async (_label, parentSource) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-include-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'base.json'), parentSource);
        const childPath = join(directory, 'child.json');
        await writeFile(childPath, JSON.stringify({ include: './base.json', name: 'Child' }));
        let rejection: CaxriError | undefined;
        try {
            await importTheme(childPath, draculaTheme);
        } catch (error_) {
            rejection = error_ as CaxriError;
        }
        expect(rejection?.code).toBe('VALIDATION');
        expect(rejection?.message).toMatch(/^JSON theme file (could not be parsed|is empty)/);
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
