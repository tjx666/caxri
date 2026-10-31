import type { AppLocale } from '@caxri/protocol';
import { resolveAppLocale } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

export interface ExtensionLanguageInputs {
    preference: AppLocale | null;
    systemLanguages: readonly string[];
}

/**
 * The interface language extensions render in, resolved from the `workbench.language` setting and the system language
 * Desktop Main reports, since Server Core has no display and may run on another machine. Memory only; until Desktop
 * reports, `Follow system` resolves to English.
 */
export class ExtensionLanguage {
    private inputs: ExtensionLanguageInputs = { preference: null, systemLanguages: [] };
    locale: AppLocale = 'en';

    /**
     * Applies a change to either input and returns the new language when the resolved language moved.
     */
    update(
        update: Partial<ExtensionLanguageInputs>,
        logger: StructuredLogger,
    ): AppLocale | undefined {
        this.inputs = { ...this.inputs, ...update };
        const from = this.locale;
        this.locale = resolveAppLocale(this.inputs.preference, this.inputs.systemLanguages);
        if (this.locale === from) return undefined;
        logger.write('info', logEventCatalog.extensionHost.languageChanged, {
            fields: { from, to: this.locale },
        });
        return this.locale;
    }
}
