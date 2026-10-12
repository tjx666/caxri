import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { describeAgentActionTarget, resolveAgentActionTargetTitle } from '../agent-action-target';

describe('resolveAgentActionTargetTitle', () => {
    it('collapses identical Session and Terminal titles into one target title', () => {
        expect(
            resolveAgentActionTargetTitle('Investigate startup', 'Investigate startup', translate),
        ).toEqual({
            kind: 'shared',
            title: 'Investigate startup',
        });
    });

    it('keeps distinct titles labeled by their hierarchy', () => {
        expect(resolveAgentActionTargetTitle('Release planning', 'Codex', translate)).toEqual({
            kind: 'distinct',
            sessionTitle: 'Release planning',
            terminalTitle: 'Codex',
        });
    });

    it('provides stable fallbacks for missing titles', () => {
        expect(resolveAgentActionTargetTitle(' ', undefined, translate)).toEqual({
            kind: 'distinct',
            sessionTitle: 'Session',
            terminalTitle: 'Terminal',
        });
    });

    it('describes shared and distinct targets for assistive technology', () => {
        expect(
            describeAgentActionTarget(
                'Codex',
                {
                    kind: 'shared',
                    title: 'Investigate startup',
                },
                translate,
            ),
        ).toBe('Target: Codex; Investigate startup');
        expect(
            describeAgentActionTarget(
                'Codex',
                {
                    kind: 'distinct',
                    sessionTitle: 'Release planning',
                    terminalTitle: 'Codex',
                },
                translate,
            ),
        ).toBe('Target: Codex; Session: Release planning; Terminal: Codex');
    });
});
