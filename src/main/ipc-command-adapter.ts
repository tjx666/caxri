import {
    createCommandDispatcher,
    createProtocolWelcome,
    type CommandDispatcherOptions,
} from '../shared/ipc/dispatcher';
import type { CommandExecutionContext } from '../shared/ipc/principal';
import type { CommandReplyEnvelope } from '../shared/ipc/transport';
import type { ProtocolWelcome } from '../shared/ipc/version';

const electronDesktopContext = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'electron-main', generation: 1 },
} satisfies CommandExecutionContext;

/** Adapts Electron's untrusted invoke payload to the transport-neutral application dispatcher. */
export function createElectronIpcCommandAdapter(options: CommandDispatcherOptions) {
    const dispatch = createCommandDispatcher(options);
    return {
        dispatch: (envelope: unknown): Promise<CommandReplyEnvelope> =>
            dispatch(envelope, electronDesktopContext),
        negotiate: (hello: unknown): ProtocolWelcome =>
            createProtocolWelcome(options, hello, electronDesktopContext),
    };
}
