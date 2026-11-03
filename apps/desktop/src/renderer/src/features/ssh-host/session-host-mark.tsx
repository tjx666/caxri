import { environmentOfSession } from '../../lib/environment-routing';
import { HostMark } from './host-mark';

/**
 * A Session row's icon-only Host mark, when the row asks for one (`isShown`) and the Session runs on an SSH Host.
 */
export function SessionHostMark({ isShown, sessionId }: { isShown?: boolean; sessionId: string }) {
    if (isShown !== true) return null;
    return <HostMark display="icon" environmentId={environmentOfSession(sessionId)} />;
}
