import { workbenchCoreContributions } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { AGENT_ACTIVITY_CONTAINER_ID } from '../agent-activity-commands';

describe('AGENT_ACTIVITY_CONTAINER_ID', () => {
    /**
     * The Renderer re-asserts this container after a selection, so a rename on the contribution side would silently
     * stop keeping the queue on screen rather than fail anywhere.
     */
    it('names the container the Workbench Core contribution actually ships', () => {
        const contributed = workbenchCoreContributions.map(({ container }) => container.id);

        expect(contributed).toContain(AGENT_ACTIVITY_CONTAINER_ID);
    });
});
