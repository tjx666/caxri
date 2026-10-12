import type { Translate } from '../../i18n';
import type { TerminalLinkScanStatus } from './terminal-link-scanner';

export function terminalLinkPickerCopy(
    t: Translate,
    mode: 'candidates' | 'detected',
    isCommit: boolean,
    status: TerminalLinkScanStatus,
) {
    if (mode === 'candidates')
        return isCommit
            ? {
                  title: t('terminal.linkPicker.repository.title'),
                  placeholder: t('terminal.linkPicker.repository.placeholder'),
                  empty: t('terminal.linkPicker.repository.empty'),
              }
            : {
                  title: t('terminal.linkPicker.file.title'),
                  placeholder: t('terminal.linkPicker.file.placeholder'),
                  empty: t('terminal.linkPicker.file.empty'),
              };
    return {
        title: t('terminal.linkPicker.detected.title'),
        placeholder: t('terminal.linkPicker.detected.placeholder'),
        empty: t(
            status === 'scanning'
                ? 'terminal.linkPicker.detected.scanning'
                : 'terminal.linkPicker.detected.empty',
        ),
    };
}
