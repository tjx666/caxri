import { useTranslation } from '../../../i18n';
import { useWorkbenchStore } from '../../../stores/workbench';
import { labelsFor } from '../session-label-snapshot';
import type { SessionLabel } from '../session-labels';

/**
 * The title and collision suffix of one Session's PrimarySidebar row, from the same rule every Session label uses. Two
 * primitive selectors keep a row quiet through changes that did not touch it.
 */
export function useSessionLabel(sessionId: string): { suffix?: string; title: string } {
    const { t } = useTranslation();
    const untitledLabel = t('session.untitled');
    const select = (
        state: ReturnType<typeof useWorkbenchStore.getState>,
    ): SessionLabel | undefined =>
        state.bootstrap
            ? labelsFor(
                  state.bootstrap.sessions,
                  state.bootstrap.projects,
                  state.bootstrap.terminals,
                  untitledLabel,
              ).get(sessionId)
            : undefined;
    const title = useWorkbenchStore((state) => select(state)?.title);
    const suffix = useWorkbenchStore((state) => select(state)?.suffix);
    return { suffix, title: title ?? untitledLabel };
}
