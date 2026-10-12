import { CheckCircle2, Download, TriangleAlert } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { useSettings } from '../../stores/selectors';
import { showUpdateDialog, useUpdateStore } from '../updates/update-commands';
import { describeUpdateChip } from '../updates/update-presentation';
import { StatusItem } from './status-item';

/**
 * The durable half of the update lifecycle. Downloading and ready-to-install outlive any dialog the user closed, and an
 * available release the user merely set aside still has to be reachable without waiting for the next launch: none of
 * which a modal can carry. Clicking opens the same dialog the `Check for Updates` command does.
 *
 * Muted tokens, like the Screencast chip: DESIGN.md reserves a coloured status-bar chip for a degraded Caxri, and
 * neither an available update nor a failed download is one: the app is working, the release is not. The failure is
 * carried by the icon and the label instead of by colour.
 */
const updateChipClassName = 'text-muted';

const UPDATE_CHIP_ICONS = {
    available: Download,
    downloading: Download,
    failed: TriangleAlert,
    ready: CheckCircle2,
} as const;

export function UpdateStatusChip() {
    const { t } = useTranslation();
    const state = useUpdateStore((store) => store.state);
    const chip = describeUpdateChip(state, useSettings()?.['updates.skippedVersion'], t);
    if (!chip) return null;
    const ChipIcon = UPDATE_CHIP_ICONS[chip.kind];
    return (
        <StatusItem
            icon={<ChipIcon />}
            ariaLabel={chip.description}
            title={chip.description}
            className={updateChipClassName}
            onClick={showUpdateDialog}
        >
            {chip.label}
        </StatusItem>
    );
}
