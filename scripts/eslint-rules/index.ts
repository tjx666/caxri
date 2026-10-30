import type { ESLint } from 'eslint';

import architectureBoundaries from './architecture-boundaries';
import boundedExternalReads from './bounded-external-reads';
import featureDirectoryStructure from './feature-directory-structure';
import filenameExportMapping from './filename-export-mapping';
import jsdocFormat from './jsdoc-format';
import listenerFanoutIsolation from './listener-fanout-isolation';
import nativeTitle from './native-title';
import noDeclareImplicitAnyVariable from './no-declare-implicit-any-variable';
import noRenderTranslate from './no-render-translate';
import noSchemaVersionOffset from './no-schema-version-offset';
import registeredColorUtilities from './registered-color-utilities';
import relativeImportExtension from './relative-import-extension';
import serverReadsThroughQuery from './server-reads-through-query';

/**
 * Caxri-local flat-config ESLint plugin. Wired into `eslint.config.ts` as `caxri/*` rules; see
 * `.agents/skills/source-layout/SKILL.md` for the naming and directory contracts they enforce.
 */
const caxriEslintPlugin: ESLint.Plugin = {
    rules: {
        'architecture-boundaries': architectureBoundaries,
        'bounded-external-reads': boundedExternalReads,
        'feature-directory-structure': featureDirectoryStructure,
        'filename-export-mapping': filenameExportMapping,
        'jsdoc-format': jsdocFormat,
        'listener-fanout-isolation': listenerFanoutIsolation,
        'native-title': nativeTitle,
        'no-declare-implicit-any-var': noDeclareImplicitAnyVariable,
        'no-render-translate': noRenderTranslate,
        'no-schema-version-offset': noSchemaVersionOffset,
        'registered-color-utilities': registeredColorUtilities,
        'relative-import-extension': relativeImportExtension,
        'server-reads-through-query': serverReadsThroughQuery,
    },
};

export default caxriEslintPlugin;
