import { AppWindow } from 'lucide-react';

import { useTranslation } from '../../i18n';

/**
 * The marker that follows the title of a Session another window has open: a window glyph, plus screen-reader text
 * because the glyph is visual only. Selecting such a row brings that window forward.
 */
export function SessionOpenLabel({ isOpenElsewhere }: { isOpenElsewhere: boolean }) {
    const { t } = useTranslation();
    if (!isOpenElsewhere) return null;
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
