import type { TerminalLinkScanStatus } from './terminal-link-scanner';

export function terminalLinkPickerCopy(
    mode: 'candidates' | 'detected',
    isCommit: boolean,
    status: TerminalLinkScanStatus,
) {
    if (mode === 'candidates')
        return isCommit
            ? {
                  title: 'Choose Git Repository',
                  placeholder: 'Search matching repositories…',
                  empty: 'No matching repositories.',
              }
            : {
                  title: 'Choose Terminal File',
                  placeholder: 'Search matching files…',
                  empty: 'No matching files.',
              };
    return {
        title: 'Open Detected Link',
        placeholder: 'Search links in the Terminal…',
        empty:
            status === 'scanning'
                ? 'Scanning Terminal links…'
                : 'No links found in the Terminal buffer.',
    };
}
