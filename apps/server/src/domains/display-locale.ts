import type { AppLocale } from '@caxri/protocol';
import { resolveAppLocale } from '@caxri/protocol';

import type { ConfigService } from './config';
import type { DomainDependencies } from './domain-services';

/**
 * Reads Caxri's interface language as Desktop shows it: the `workbench.language` setting, or the system language
 * Desktop Main last reported when it follows the system. Before any Desktop reports, `Follow system` resolves to
 * English.
 */
export function displayLocaleReader(
    config: Pick<ConfigService, 'getSettings'>,
    dependencies: Pick<DomainDependencies, 'systemLanguages'>,
): () => AppLocale {
    return () =>
        resolveAppLocale(
            config.getSettings().value['workbench.language'],
            dependencies.systemLanguages?.() ?? [],
        );
}
