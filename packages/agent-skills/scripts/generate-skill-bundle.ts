import { readFile, writeFile } from 'node:fs/promises';

import { formatSource } from '../../../scripts/format-source';

interface FileSystemError extends Error {
    code?: string;
}

export async function didWriteFileIfChanged(path: URL | string, source: string): Promise<boolean> {
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
    const outputUrl = new URL('src/caxri-skill.generated.ts', packageRoot);
    const files = {
        'SKILL.md': await readFile(new URL('../../skills/caxri-cli/SKILL.md', packageRoot), 'utf8'),
        'agents/openai.yaml': await readFile(
            new URL('../../skills/caxri-cli/agents/openai.yaml', packageRoot),
            'utf8',
        ),
    };

    /**
     * The header stays in the multi-line JSDoc form eslint --fix settles on, so regeneration and lint-staged never
     * flip-flop the committed file between the two comment shapes.
     */
    const source = `/**
 * Generated from skills/caxri-cli. Do not edit directly.
 */
export const CAXRI_SKILL_FILES = ${JSON.stringify(files, null, 4)} as const;
`;
    await didWriteFileIfChanged(outputUrl, await formatSource(source, outputUrl.pathname));
}

if (import.meta.main) await generateSkillBundle();
