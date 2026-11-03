import type { ProjectRecord } from '@caxri/protocol';

import { environmentOfProject } from '../../lib/environment-routing';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';
import { HostMark } from './host-mark';
import { remoteMachinesOf } from './remote-machines';

/**
 * A collapsed merged Project heading's marks: only the SSH Hosts among `environmentIds` whose connection needs
 * attention, since the connection rows under the heading are folded away with it.
 */
function UnhealthyHostMarks({ environmentIds }: { environmentIds: readonly string[] }) {
    const unhealthy = useEnvironmentStore((store) =>
        environmentIds
            .filter(
                (environmentId) =>
                    store.hosts.find((host) => environmentIdOf(host) === environmentId)?.phase !==
                    'connected',
            )
            .join('\n'),
    );
    if (unhealthy === '') return null;
    return (
        <span className="inline-flex min-w-0 flex-none items-center gap-1.5">
            {unhealthy.split('\n').map((environmentId) => (
                <HostMark key={environmentId} display="icon" environmentId={environmentId} />
            ))}
        </span>
    );
}

/**
 * A Project heading's machine marks. A single Project's heading marks its SSH Host. A merged heading names no machine,
 * since each remote row carries its own mark; only a collapsed one flags a machine whose connection needs attention.
 */
export function ProjectHeadingHostMarks({
    isExpanded,
    members,
}: {
    isExpanded: boolean;
    /**
     * Every Project under the heading, the heading's own first.
     */
    members: readonly ProjectRecord[];
}) {
    const [lead] = members;
    if (members.length === 1) return <HostMark environmentId={environmentOfProject(lead.id)} />;
    return isExpanded ? null : <UnhealthyHostMarks environmentIds={remoteMachinesOf(members)} />;
}
