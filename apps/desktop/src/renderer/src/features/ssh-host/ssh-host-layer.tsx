import { AskpassDialog } from './askpass-dialog';
import { SshHostConnectionOverlay } from './ssh-host-connection-overlay';
import { useSshHostWindowTitle } from './use-ssh-host-window-title';

/**
 * The SSH Host surfaces that must work before the Server attaches as well as after: `App` renders this in both its
 * `LoadingScreen` branch and the Workbench branch, so neither the connection progress nor an OpenSSH prompt can be
 * hidden behind the loader. Renders nothing in a local window.
 */
export function SshHostLayer() {
    useSshHostWindowTitle();
    return (
        <>
            <SshHostConnectionOverlay />
            <AskpassDialog />
        </>
    );
}
