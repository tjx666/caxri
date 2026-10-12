import type { FileWatchLimit, FileWatchLimitAlert } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { dismissToastsMatching, pushToast } from '../../stores/toasts';

const messageKeys: Record<FileWatchLimit, TranslationKey> = {
    'watch-limit': 'sshHost.watchLimit.watches',
    'instance-limit': 'sshHost.watchLimit.instances',
};

/**
 * Persists the setting across reboots and applies it at once. 524288 is the value VS Code's Linux guide recommends;
 * each watch costs about 1 KiB of kernel memory, and only watches in use are charged.
 */
const raiseCommands: Record<FileWatchLimit, string> = {
    'watch-limit':
        'echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p',
    'instance-limit':
        'echo fs.inotify.max_user_instances=512 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p',
};

/**
 * The notice this window shows for the current episode. The Server raises again for every watch that hits the limit, so
 * a window that connected later still learns about it; this keeps one episode to one notice, even after the user
 * dismissed it, until the Server reports the episode over.
 */
const live: { message?: string } = {};

function dismissLiveAlert(): void {
    const { message } = live;
    live.message = undefined;
    if (message) dismissToastsMatching((title) => title === message);
}

/**
 * Tells the user why the file tree and Git status of an SSH Host window lag behind, and how an administrator lifts the
 * limit. It persists because the cause stays until someone changes the machine's settings.
 */
export function reportFileWatchLimitAlert(alert: FileWatchLimitAlert): void {
    if (alert.state === 'cleared') {
        dismissLiveAlert();
        return;
    }
    const message = translate(messageKeys[alert.reason]);
    if (message === live.message) return;
    dismissLiveAlert();
    live.message = message;
    pushToast('warning', message, {
        persist: true,
        action: { id: 'clipboard.copyCommand', params: { text: raiseCommands[alert.reason] } },
    });
}

export function subscribeFileWatchLimitAlerts(): () => void {
    return caxri.onEvent((event) => {
        if (event.event === 'files.watchLimitAlert') reportFileWatchLimitAlert(event.payload);
    });
}
