import { useEffect } from 'react';

import { useTranslation } from '../../i18n';
import { useEnvironmentStore } from '../../stores/environment';

/**
 * Names an SSH Host window `SSH: <destination>` so the Window menu, Mission Control, and the Dock tell it apart from
 * the local window. A local window keeps the title `index.html` gave it.
 */
export function useSshHostWindowTitle(): void {
    const { t } = useTranslation();
    const destination = useEnvironmentStore((store) =>
        store.state?.kind === 'ssh' ? store.state.destination : undefined,
    );
    useEffect(() => {
        if (destination !== undefined) document.title = t('sshHost.windowTitle', { destination });
    }, [destination, t]);
}
