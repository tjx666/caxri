import type { ESLint } from 'eslint';

import architectureBoundaries from './architecture-boundaries';
import featureDirectoryStructure from './feature-directory-structure';
import filenameExportMapping from './filename-export-mapping';
import listenerFanoutIsolation from './listener-fanout-isolation';
import nativeTitle from './native-title';
import noDeclareImplicitAnyVariable from './no-declare-implicit-any-variable';
import registeredColorUtilities from './registered-color-utilities';
import serverReadsThroughQuery from './server-reads-through-query';

/**
 * Caxri-local flat-config ESLint plugin. Wired into `eslint.config.ts` as `caxri/*` rules; see
 * `.agents/skills/source-layout/SKILL.md` for the naming and directory contracts they enforce.
 */
const caxriEslintPlugin: ESLint.Plugin = {
    rules: {
        'architecture-boundaries': architectureBoundaries,
        'feature-directory-structure': featureDirectoryStructure,
        'filename-export-mapping': filenameExportMapping,
        'listener-fanout-isolation': listenerFanoutIsolation,
        'native-title': nativeTitle,
        'no-declare-implicit-any-var': noDeclareImplicitAnyVariable,
        'registered-color-utilities': registeredColorUtilities,
        'server-reads-through-query': serverReadsThroughQuery,
    },
};

export default caxriEslintPlugin;
