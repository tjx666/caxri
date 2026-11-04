import { isCaxriError } from '@caxri/protocol';

import { translate } from '../../i18n';
import { describeFailureKey, pushToast } from '../../stores/toasts';
import type { OpenTerminalFileTargetOptions } from './terminal-file-link-open';
import { revealTerminalFileLink } from './terminal-link-commands';

const onError = (message: string): void => pushToast('error', message);

/**
 * Shows a file path a Terminal printed, or an Agent Chat reply cited, in Finder, resolved against the Projects that
 * Terminal may reach. A path that resolves nowhere tries `fallbackTarget` once, as an open does, so a file the Agent
 * wrote outside every Project and cited by name is still found. Several matches, a miss, or a failure is reported as a
 * toast rather than revealing a guess. Never rejects.
 */
export async function revealTerminalFileTarget(
    terminalId: string,
    target: string,
    { fallbackTarget }: Pick<OpenTerminalFileTargetOptions, 'fallbackTarget'> = {},
): Promise<void> {
    try {
        const result = await revealTerminalFileLink(terminalId, target);
        if ('status' in result)
            onError(translate('terminal.links.fileAmbiguous', { name: target }));
    } catch (error) {
        if (isCaxriError(error) && error.code === 'NOT_FOUND') {
            const fallback = fallbackTarget?.();
            if (fallback && 'candidates' in fallback) {
                onError(translate('terminal.links.fileAmbiguous', { name: target }));
                return;
            }
            if (fallback && fallback.path !== target) {
                await revealTerminalFileTarget(terminalId, fallback.path);
                return;
            }
            onError(translate('terminal.links.fileNotFound', { path: target }));
            return;
        }
        onError(describeFailureKey(error, 'terminal.links.fileRevealFailed', translate));
    }
}
