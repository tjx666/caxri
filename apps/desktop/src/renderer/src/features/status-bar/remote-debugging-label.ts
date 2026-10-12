import type { RemoteDebuggingState } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

export interface RemoteDebuggingChipCopy {
    /**
     * The chip's visible text, short enough to sit on the crowded actions rail.
     */
    text: string;
    /**
     * Accessible name. The chip's two words cannot carry the consequence, so the long form states who can connect and
     * what they get, in the same words the Settings row uses.
     */
    description: string;
    /**
     * The hover tooltip: the same facts as `description`, split into a heading, the channel, and the consequence.
     */
    tooltip: StructuredTooltipData;
}

/**
 * The chip's copy for a debugging channel that is actually open, or undefined when nothing is listening.
 *
 * Caxri ships with the port on, so for most users this is the only place the product admits it. The sentence names the
 * consequence rather than the mechanism: "Chrome DevTools Protocol" tells a user nothing about what a connection can
 * do, and "can read every window and act as you" is the part that decides whether they want it on.
 */
export function remoteDebuggingChipCopy(
    state: RemoteDebuggingState,
    t: Translate = translate,
): RemoteDebuggingChipCopy | undefined {
    if (state.transport === 'disabled') return undefined;
    const where =
        state.transport === 'pipe'
            ? t('statusBar.remoteDebugging.wherePipe')
            : state.port
              ? t('statusBar.remoteDebugging.wherePort', { port: state.port })
              : t('statusBar.remoteDebugging.whereLoopback');
    const consequence = t('statusBar.remoteDebugging.consequence');
    return {
        text: t(
            state.transport === 'pipe'
                ? 'statusBar.remoteDebugging.pipeText'
                : 'statusBar.remoteDebugging.portText',
        ),
        description: t('statusBar.remoteDebugging.description', { where, consequence }),
        tooltip: {
            title: t('statusBar.remoteDebugging.title'),
            rows: [
                state.transport === 'pipe'
                    ? {
                          label: t('statusBar.remoteDebugging.channel'),
                          value: t('statusBar.remoteDebugging.channelPipe'),
                      }
                    : {
                          label: t('statusBar.remoteDebugging.address'),
                          value: state.port
                              ? `127.0.0.1:${state.port}`
                              : t('statusBar.remoteDebugging.addressLoopback'),
                          isCode: Boolean(state.port),
                      },
            ],
            notes: [consequence],
            hint: t('statusBar.remoteDebugging.hint'),
        },
    };
}
