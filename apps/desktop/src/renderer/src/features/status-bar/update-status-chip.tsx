import { CheckCircle2, Download } from 'lucide-react';

import { useSettings } from '../../stores/selectors';
import { showUpdateDialog, useUpdateStore } from '../updates/update-commands';
import { describeUpdateChip } from '../updates/update-presentation';
import { StatusItem } from './status-item';

/**
 * The durable half of the update lifecycle. Downloading and ready-to-install outlive any dialog the user closed, and an
 * available release the user merely set aside still has to be reachable without waiting for the next launch — none of
 * which a modal can carry. Clicking opens the same dialog the `Check for Updates` command does.
 *
 * Muted tokens, like the Screencast chip: DESIGN.md reserves a coloured status-bar chip for a degraded Caxri, and an
 * available update is not a degradation.
 */
const updateChipClassName = 'text-muted';

export function UpdateStatusChip() {
    const state = useUpdateStore((store) => store.state);
    const chip = describeUpdateChip(state, useSettings()?.['updates.skippedVersion']);
    if (!chip) return null;
    return (
        <StatusItem
            icon={chip.kind === 'ready' ? CheckCircle2 : Download}
            ariaLabel={chip.description}
            title={chip.description}
            className={updateChipClassName}
            onClick={showUpdateDialog}
        >
            {chip.label}
        </StatusItem>
    );
}
