import { AskpassDialog } from './askpass-dialog';
import { SshHostConnectionOverlay } from './ssh-host-connection-overlay';

/**
 * The SSH Host surfaces that must work before this Mac's Server attaches as well as after: `App` renders this in both
 * its `LoadingScreen` branch and the Workbench branch, so an OpenSSH prompt for a Host reconnecting on launch is never
 * hidden behind the loader. Renders nothing while no Host needs attention.
 */
export function SshHostLayer() {
    return (
        <>
            <SshHostConnectionOverlay />
            <AskpassDialog />
        </>
    );
}
