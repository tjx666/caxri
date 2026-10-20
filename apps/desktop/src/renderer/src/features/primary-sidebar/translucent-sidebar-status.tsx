import { FieldDescription } from '../../components/ui/field';
import { useTranslation } from '../../i18n';
import { useTranslucentSidebarInput } from './hooks/use-translucent-sidebar';
import { translucentSidebarInactiveReason } from './translucent-sidebar';

/**
 * The muted caption under the Translucent sidebar Settings row while the Setting is on but the sidebar is opaque, so a
 * switch that looks on and does nothing says why. Renders nothing while the sidebar is frosted or the Setting is off.
 */
export function TranslucentSidebarStatus() {
    const { t } = useTranslation();
    const reason = translucentSidebarInactiveReason(useTranslucentSidebarInput());
    if (!reason) return null;
    return (
        <FieldDescription role="status">
            {t(`settings.primarySidebar.translucent.inactive.${reason}`)}
        </FieldDescription>
    );
}
