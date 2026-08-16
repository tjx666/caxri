import type { ESLint } from 'eslint';

import filenameExportMapping from './filename-export-mapping';

/**
 * Caxri-local flat-config ESLint plugin. Wired into `eslint.config.ts` as `caxri/filename-export-mapping`; see
 * `.agents/skills/source-layout/SKILL.md` for the naming contract it enforces.
 */
const caxriEslintPlugin: ESLint.Plugin = {
    rules: {
        'filename-export-mapping': filenameExportMapping,
    },
};

export default caxriEslintPlugin;
