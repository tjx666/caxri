import type { ReactNode } from 'react';

import { I18nProvider } from '../i18n';
import { useSettings } from '../stores/selectors';

/**
 * Localizes a window that renders from the Workbench snapshot (the Workbench and the Agent Commander) in the language
 * its `workbench.language` setting selects.
 */
export function WorkbenchI18nProvider({ children }: { children: ReactNode }) {
    return (
        <I18nProvider preference={useSettings()?.['workbench.language']}>{children}</I18nProvider>
    );
}
