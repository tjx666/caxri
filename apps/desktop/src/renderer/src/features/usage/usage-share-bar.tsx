import { ShareBar } from '../../components/share-bar';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import type { UsageShareBasis } from './usage-presentation';
import { usageShareLabel } from './usage-presentation';

/**
 * A Usage share bar with its figure, `42% of cost`, in a Tooltip and as screen-reader text, so the bar's basis (cost or
 * tokens, see `usageShareBasis`) is readable on the bar itself and not only from the card caption.
 */
export function UsageShareBar({ basis, share }: { basis: UsageShareBasis; share: number }) {
    const { t } = useTranslation();
    const label = usageShareLabel(t, share, basis);
    return (
        <Tooltip content={label}>
            {/* The vertical padding widens the 4px bar into a target the pointer can actually land on. */}
            <div className="py-1">
                <ShareBar share={share} />
                <span className="sr-only">{label}</span>
            </div>
        </Tooltip>
    );
}
