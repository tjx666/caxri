import { AppWindow } from 'lucide-react';

import { useTranslation } from '../../i18n';
import type { SessionOpenPlace } from '../../stores/open-sessions';

/**
 * The part of the marker that follows the title: a window glyph for a Session another window owns, and screen-reader
 * text for both places, since the edge bar and the glyph are visual only.
 */
export function SessionOpenLabel({ place }: { place: SessionOpenPlace | undefined }) {
    const { t } = useTranslation();
    if (place === 'here')
        return <span className="sr-only">{t('primarySidebar.session.openHere')}</span>;
    if (place !== 'elsewhere') return null;
    return (
        <>
            <AppWindow
                aria-hidden="true"
                className="session-open-elsewhere flex-none text-muted"
                size={11}
            />
            <span className="sr-only">{t('primarySidebar.session.openElsewhere')}</span>
        </>
    );
}
