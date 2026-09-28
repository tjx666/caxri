import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { solarizedLightTheme } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function writeThemeFile(prefix: string, fileName: string, source: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `caxri-theme-${prefix}-`));
    temporaryDirectories.push(directory);
    const path = join(directory, fileName);
    await writeFile(path, source, 'utf8');
    return path;
}

async function rejectionOf(path: string): Promise<CaxriError> {
    try {
        await importTheme(path, draculaTheme);
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error(`Expected the import of ${path} to be rejected`);
}

/**
 * Shaped like a real iTerm2 preset export, DOCTYPE included, so the fixture exercises the same document the plist
 * parser sees in practice. The external DTD is never fetched.
 */
const ITERM_PRESET = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Background Color</key>
\t<dict>
\t\t<key>Blue Component</key><real>0.0</real>
\t\t<key>Green Component</key><real>0.0</real>
\t\t<key>Red Component</key><real>0.0</real>
\t</dict>
\t<key>Ansi 1 Color</key>
\t<dict>
\t\t<key>Blue Component</key><real>0.0</real>
\t\t<key>Green Component</key><real>0.2</real>
\t\t<key>Red Component</key><real>1.0</real>
\t</dict>
</dict>
</plist>
`;

describe('iTerm2 theme import', () => {
    it('maps preset colors and leaves the app and editor palette to the active theme', async () => {
        const path = await writeThemeFile('iterm-ok', 'Night.itermcolors', ITERM_PRESET);

        const theme = await importTheme(path, solarizedLightTheme);

        expect(theme).toMatchObject({
            name: 'Night',
            source: 'iterm2',
            terminal: { background: '#000000', red: '#ff3300' },
        });
        // Terminal-only formats carry no app or editor colors, so those come from the theme already in use.
        expect(theme.colors.background).toBe(solarizedLightTheme.colors.background);
        expect(theme.editor.comment).toBe(solarizedLightTheme.editor.comment);
        // Unset entries still fall back, which is why the zero-hit check below is what stops a silent import.
        expect(theme.terminal.green).toBe(draculaTheme.terminal.green);
        expect(theme.warnings).toContainEqual(
            expect.objectContaining({ id: 'iterm-terminal-only' }),
        );
    });

    it('rejects an unparseable preset instead of reporting an unclassified fault', async () => {
        const path = await writeThemeFile('iterm-empty', 'Broken.itermcolors', '');

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('not a readable iTerm2 color preset');
        // The xmldom message is not forwarded: parser text can quote the file's own contents.
        expect(error.message).not.toContain('root element');
    });

    it('rejects a preset whose property list root is not a dictionary', async () => {
        const path = await writeThemeFile(
            'iterm-root',
            'Rootless.itermcolors',
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"></plist>',
        );

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('dictionary root');
    });

    it('rejects a syntactically valid preset that defines no importable color', async () => {
        const path = await writeThemeFile(
            'iterm-zero-hit',
            'Empty.itermcolors',
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>',
        );

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('does not define any colors Caxri can import');
    });
});

describe('Warp theme import', () => {
    it('rejects an empty theme file instead of dereferencing a null document', async () => {
        const path = await writeThemeFile('warp-empty', 'empty.yaml', '\n\n# only a comment\n');

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('This Warp theme is empty');
    });

    it.each([
        { label: 'a scalar', source: '5\n' },
        { label: 'a list', source: '- "#ff0000"\n- "#00ff00"\n' },
    ])(
        'rejects $label document root rather than cloning the fallback theme',
        async ({ source }) => {
            const path = await writeThemeFile('warp-root', 'degenerate.yaml', source);

            const error = await rejectionOf(path);

            expect(error.code).toBe('VALIDATION');
            expect(error.message).toContain('YAML mapping');
        },
    );

    it('reports the position of a YAML syntax error without quoting the source', async () => {
        const path = await writeThemeFile(
            'warp-syntax',
            'broken.yaml',
            'name: Broken\nbackground: "#112233\n',
        );

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('not a readable Warp theme');
        expect(error.message).toMatch(/\(line \d+, column \d+\)$/);
        expect(error.message).not.toContain('background:');
    });

    it('rejects a mapping that names the theme but defines no color', async () => {
        const path = await writeThemeFile('warp-zero-hit', 'nameonly.yaml', 'name: Just A Name\n');

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('does not define any colors Caxri can import');
    });
});

describe('JSON theme import', () => {
    it('rejects an empty file with a readable reason and its position', async () => {
        const path = await writeThemeFile('json-empty', 'empty.json', '');

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('not readable JSON');
        expect(error.message).toContain('(line 1, column 1)');
        // `ValueExpected` is jsonc-parser's own code name and means nothing to the person picking the file.
        expect(error.message).not.toContain('ValueExpected');
    });

    it.each([
        { label: 'a null', source: 'null' },
        { label: 'a string', source: '"#ff0000"' },
        { label: 'an array', source: '[]' },
    ])(
        'rejects $label document root rather than cloning the fallback theme',
        async ({ source }) => {
            const path = await writeThemeFile('json-root', 'degenerate.json', source);

            const error = await rejectionOf(path);

            expect(error.code).toBe('VALIDATION');
            expect(error.message).toContain('not a JSON object');
        },
    );

    it('rejects a malformed include parent instead of reporting an unclassified fault', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-json-include-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'base.json'), '{ "colors": { ', 'utf8');
        const path = join(directory, 'child.json');
        await writeFile(
            path,
            JSON.stringify({ include: './base.json', colors: { 'editor.background': '#101010' } }),
            'utf8',
        );

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('not readable JSON');
    });

    it('reports an include parent that is not a JSON object as such, not as a bad path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-json-include-root-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'base.json'), '[]', 'utf8');
        const path = join(directory, 'child.json');
        await writeFile(
            path,
            JSON.stringify({ include: './base.json', colors: { 'editor.background': '#101010' } }),
            'utf8',
        );

        const error = await rejectionOf(path);

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toContain('not a JSON object');
        // The parent sits beside the child, so blaming the include path would point at the one thing that is right.
        expect(error.message).not.toContain('same directory');
    });
});
