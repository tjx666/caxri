import { readFile, writeFile } from 'node:fs/promises';

import { format, resolveConfig } from 'prettier';

const packageRoot = new URL('../', import.meta.url);
const outputUrl = new URL('src/caxri-skill.generated.ts', packageRoot);
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
await writeFile(
    outputUrl,
    await format(source, { ...configuration, filepath: outputUrl.pathname }),
    'utf8',
);
