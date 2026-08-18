import type { ESLint } from 'eslint';

import featureDirectoryStructure from './feature-directory-structure';
import filenameExportMapping from './filename-export-mapping';

/**
 * Caxri-local flat-config ESLint plugin. Wired into `eslint.config.ts` as `caxri/*` rules; see
 * `.agents/skills/source-layout/SKILL.md` for the naming and directory contracts they enforce.
 */
const caxriEslintPlugin: ESLint.Plugin = {
    rules: {
        'feature-directory-structure': featureDirectoryStructure,
        'filename-export-mapping': filenameExportMapping,
    },
};

export default caxriEslintPlugin;
