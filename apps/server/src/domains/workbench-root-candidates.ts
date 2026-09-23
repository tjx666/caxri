import { randomUUID } from 'node:crypto';

import type { ServerEvent } from '@caxri/protocol';

const MAX_CANDIDATES = 256;

export interface WorkbenchCandidate {
    candidateId: string;
    repositoryKey: string;
    rootPath: string;
    sessionId: string;
    state: 'pending' | 'claimed';
}

/**
 * A repeated observation keeps the visible candidate id, including while Main is claiming it.
 */
export function addWorkbenchCandidate(
    candidates: Map<string, WorkbenchCandidate>,
    input: Pick<WorkbenchCandidate, 'repositoryKey' | 'rootPath' | 'sessionId'>,
    emit: (event: ServerEvent) => void,
): void {
    for (const [candidateId, candidate] of candidates) {
        if (candidate.sessionId !== input.sessionId) continue;
        if (
            candidate.repositoryKey === input.repositoryKey &&
            candidate.rootPath === input.rootPath
        )
            return;
        candidates.delete(candidateId);
    }
    while (candidates.size >= MAX_CANDIDATES) {
        const oldest = candidates.keys().next().value;
        if (!oldest) break;
        candidates.delete(oldest);
    }
    const candidateId = randomUUID();
    candidates.set(candidateId, { ...input, candidateId, state: 'pending' });
    emit({
        event: 'workbench.candidate',
        payload: { candidateId, sessionId: input.sessionId, rootPath: input.rootPath },
    });
}
