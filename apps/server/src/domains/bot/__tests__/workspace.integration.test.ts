import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { BOT_PROJECT_DOC_MAX_BYTES } from '../launch';
import { BOT_MEMORY_EMBED_BYTES, BOT_WORKSPACE_DIRECTORY, prepareBotWorkspace } from '../workspace';

async function profile() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-workspace-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

describe('prepareBotWorkspace', () => {
    it('seeds the memory files once and embeds them after the instructions', async () => {
        const userData = await profile();
        const { path } = await prepareBotWorkspace(userData);
        const repositories = join(path, 'memory', 'repositories.md');
        expect(await readFile(repositories, 'utf8')).toMatch(/^# Repositories/u);

        await writeFile(repositories, '# Repositories\n\n## billing\n- Owns: invoices\n');
        await prepareBotWorkspace(userData);

        expect(await readFile(repositories, 'utf8')).toContain('Owns: invoices');
        const instructions = await readFile(join(path, 'AGENTS.md'), 'utf8');
        expect(instructions).toMatch(/^# Caxri Bot/u);
        expect(instructions).toContain('## Current memory');
        expect(instructions).toContain('### memory/repositories.md\n\n# Repositories');
        expect(instructions).toContain('- Owns: invoices');
        expect(instructions).toContain('### memory/lessons.md');
        expect(path.endsWith(BOT_WORKSPACE_DIRECTORY)).toBe(true);
    });

    it('cuts memory over the budget at a line boundary and stays under the Codex limit', async () => {
        const userData = await profile();
        const { path } = await prepareBotWorkspace(userData);
        const line = `- ${'长'.repeat(60)}\n`;
        await writeFile(
            join(path, 'memory', 'lessons.md'),
            `# Lessons\n\n${line.repeat(Math.ceil(BOT_MEMORY_EMBED_BYTES / line.length))}`,
        );

        await prepareBotWorkspace(userData);

        const instructions = await readFile(join(path, 'AGENTS.md'), 'utf8');
        expect(instructions).toContain('(Truncated: read `memory/lessons.md` for the rest');
        expect(instructions).not.toContain('�');
        expect(Buffer.byteLength(instructions)).toBeLessThan(BOT_PROJECT_DOC_MAX_BYTES);
    });
});
