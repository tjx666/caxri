import { readFile, writeFile } from 'node:fs/promises';

import { format, resolveConfig } from 'prettier';

interface FileSystemError extends Error {
    code?: string;
}

export async function writeFileIfChanged(path: URL | string, source: string): Promise<boolean> {
    try {
        if ((await readFile(path, 'utf8')) === source) return false;
    } catch (error) {
        if ((error as FileSystemError).code !== 'ENOENT') throw error;
    }
    await writeFile(path, source, 'utf8');
    return true;
}

async function generateSkillBundle(): Promise<void> {
    const packageRoot = new URL('../', import.meta.url);
    const outputUrl = new URL('src/skills/caxri-skill.generated.ts', packageRoot);
    const files = {
        'SKILL.md': await readFile(new URL('../../skills/caxri-cli/SKILL.md', packageRoot), 'utf8'),
        'agents/openai.yaml': await readFile(
            new URL('../../skills/caxri-cli/agents/openai.yaml', packageRoot),
            'utf8',
        ),
    };

    const source = `/** Generated from skills/caxri-cli. Do not edit directly. */
export const CAXRI_SKILL_FILES = ${JSON.stringify(files, null, 4)} as const;
`;
    const configuration = (await resolveConfig(outputUrl.pathname)) ?? {};
    await writeFileIfChanged(
        outputUrl,
        await format(source, { ...configuration, filepath: outputUrl.pathname }),
    );
}

if (import.meta.main) await generateSkillBundle();
