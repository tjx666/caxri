import type { ProjectRecord } from '@caxri/protocol';

import { caxri } from '../lib/caxri';
import { environmentOfProject } from '../lib/environment-routing';
import { createStore } from '../lib/store';

interface ProjectRepositoriesState {
    /**
     * Each Project's repository key (`project.repositoryKeys`), or `null` when it has no usable `origin`. A Project
     * absent here has not been asked about yet.
     */
    keys: Readonly<Record<string, string | null>>;
}

/**
 * Which repository each Project is a checkout of, so the side bar can show one heading for a repository that lives on
 * several machines. Kept in memory only: a key never changes for a Project id, and a relaunch asks again.
 */
export const useProjectRepositoriesStore = createStore<ProjectRepositoriesState>(
    'project-repositories',
    () => ({ keys: {} }),
);

/**
 * Machines whose `project.repositoryKeys` read is in flight, so one snapshot burst asks each machine once.
 */
const pending = new Set<string | undefined>();

/**
 * Asks each machine for the repository keys of its Projects that have none yet. Only worth asking once the Workbench
 * spans more than one machine: a single machine never merges anything.
 */
export function refreshProjectRepositories(projects: readonly ProjectRecord[]): void {
    const { keys } = useProjectRepositoriesStore.getState();
    const machines = new Set(projects.map((project) => environmentOfProject(project.id)));
    if (machines.size < 2) return;
    const missing = new Set(
        projects
            .filter((project) => !(project.id in keys))
            .map((project) => environmentOfProject(project.id)),
    );
    for (const environmentId of missing) {
        if (pending.has(environmentId)) continue;
        pending.add(environmentId);
        void (async () => {
            try {
                const read = await caxri.in(environmentId).request('project.repositoryKeys');
                useProjectRepositoriesStore.setState((state) => ({
                    keys: { ...state.keys, ...read },
                }));
            } catch {
                // Best effort: an unread machine's Projects stay unmerged until the next snapshot asks again.
            } finally {
                pending.delete(environmentId);
            }
        })();
    }
}
