import type { E2EApp } from './electron-app.ts';

const GPU_RESTART_STUB_KEY = '__caxriE2EGpuRestartStub';

interface GpuRestartStubState {
    didQuit: boolean;
    didRelaunch: boolean;
}

export async function stubGpuSafeModeRestart(app: E2EApp): Promise<void> {
    await app.evaluate(({ app: electronApp }, key) => {
        const scope = globalThis as Record<string, unknown>;
        if (scope[key]) throw new Error('GPU restart lifecycle is already stubbed');
        const state = {
            didQuit: false,
            didRelaunch: false,
            quitDescriptor: Object.getOwnPropertyDescriptor(electronApp, 'quit'),
            relaunchDescriptor: Object.getOwnPropertyDescriptor(electronApp, 'relaunch'),
        };
        scope[key] = state;
        Object.defineProperties(electronApp, {
            quit: {
                configurable: true,
                value: () => {
                    state.didQuit = true;
                },
            },
            relaunch: {
                configurable: true,
                value: () => {
                    state.didRelaunch = true;
                },
            },
        });
    }, GPU_RESTART_STUB_KEY);
}

export async function readGpuSafeModeRestart(app: E2EApp): Promise<GpuRestartStubState> {
    return app.evaluate((_, key) => {
        const state = (globalThis as Record<string, unknown>)[key] as
            GpuRestartStubState | undefined;
        if (!state) throw new Error('GPU restart lifecycle is not stubbed');
        return { didQuit: state.didQuit, didRelaunch: state.didRelaunch };
    }, GPU_RESTART_STUB_KEY);
}

export async function restoreGpuSafeModeRestart(app: E2EApp): Promise<void> {
    await app.evaluate(({ app: electronApp }, key) => {
        const scope = globalThis as Record<string, unknown>;
        const state = scope[key] as
            | (GpuRestartStubState & {
                  quitDescriptor?: PropertyDescriptor;
                  relaunchDescriptor?: PropertyDescriptor;
              })
            | undefined;
        if (!state) throw new Error('GPU restart lifecycle is not stubbed');
        if (state.quitDescriptor) Object.defineProperty(electronApp, 'quit', state.quitDescriptor);
        else Reflect.deleteProperty(electronApp, 'quit');
        if (state.relaunchDescriptor)
            Object.defineProperty(electronApp, 'relaunch', state.relaunchDescriptor);
        else Reflect.deleteProperty(electronApp, 'relaunch');
        Reflect.deleteProperty(scope, key);
    }, GPU_RESTART_STUB_KEY);
}
