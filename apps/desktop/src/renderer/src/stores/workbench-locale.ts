import { applyLanguagePreference } from '../i18n';
import { useWorkbenchStore } from './workbench';

/**
 * Keeps the locale store in step with the Workbench snapshot's `workbench.language` setting.
 *
 * A store subscription runs synchronously inside the snapshot write, before React re-renders, so every component that
 * renders the change (including ones that call `translate()` through a helper) sees the new language in the same pass.
 * Updating the locale from a provider effect instead would let that first render read the previous language.
 */
export function syncWorkbenchLocale(): void {
    const apply = () =>
        applyLanguagePreference(
            useWorkbenchStore.getState().bootstrap?.settings['workbench.language'],
        );
    apply();
    useWorkbenchStore.subscribe(apply);
}
