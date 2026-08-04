import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES, type FileChange } from './types';

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(16_384);
const terminalKind = z.enum(['claude', 'codex', 'shell']);

export const requestSchemas = {
    'app.bootstrap': z.object({}),
    'app.health': z.object({}),
    'app.openConfigFile': z.object({ kind: z.enum(['settings', 'keybindings', 'theme']) }),
    'dialog.selectDirectory': z.object({}),
    'diagnostics.export': z.object({}),
    'project.create': z.object({ rootPath: path }),
    'project.cancelCreate': z.object({ rootPath: path }),
    'project.delete': z.object({ projectId: id }),
    'session.create': z.object({ projectId: id, defaultAgent: terminalKind }),
    'session.delete': z.object({ sessionId: id }),
    'session.select': z.object({ sessionId: id }),
    'session.updateState': z.object({
        sessionId: id,
        openTabs: z.array(z.object({ path, dirty: z.boolean() })).max(100),
        activeTab: path.optional(),
        inspectorMode: z.enum(['files', 'git', 'agent']),
        layout: z.object({ splitTerminalIds: z.array(id).max(4) }),
    }),
    'terminal.create': z.object({ sessionId: id, kind: terminalKind }),
    'terminal.input': z.object({ terminalId: id, data: z.string().max(65_536) }),
    'terminal.resize': z.object({
        terminalId: id,
        cols: z.number().int().min(2).max(1_000),
        rows: z.number().int().min(1).max(1_000),
    }),
    'terminal.close': z.object({ terminalId: id }),
    'terminal.attach': z.object({ terminalId: id }),
    'terminal.detach': z.object({ terminalId: id }),
    'terminal.restart': z.object({ terminalId: id }),
    'terminal.snapshot': z.object({ terminalId: id }),
    'terminal.runningCount': z.object({ sessionId: id.optional() }),
    'files.list': z.object({ sessionId: id, directory: path.optional() }),
    'files.read': z.object({ sessionId: id, path }),
    'files.write': z.object({
        sessionId: id,
        path,
        content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    }),
    'git.summary': z.object({ sessionId: id }),
    'git.diff': z.object({ sessionId: id, path }),
    'agent.snapshot': z.object({ sessionId: id, provider: z.enum(['claude', 'codex']) }),
    'settings.get': z.object({}),
    'settings.update': z.object({ source: z.string().max(128 * 1024) }),
    'keybindings.get': z.object({}),
    'keybindings.update': z.object({ source: z.string().max(128 * 1024) }),
    'theme.get': z.object({}),
    'theme.update': z.object({ source: z.string().max(256 * 1024) }),
    'theme.import': z.object({}),
} as const;

export type CaxriMethod = keyof typeof requestSchemas;

export const internalRequestSchemas = {
    'app.windowState.get': z.object({}),
    'app.windowState.update': z.object({
        bounds: z.object({
            x: z.number().int().optional(),
            y: z.number().int().optional(),
            width: z.number().int().min(640).max(16_384),
            height: z.number().int().min(480).max(16_384),
        }),
        isMaximized: z.boolean(),
        isFullScreen: z.boolean(),
    }),
    'config.paths': z.object({}),
    'diagnostics.exportPath': z.object({ destination: path }),
    'runtime.shutdown': z.object({}),
    'terminal.detachAll': z.object({}),
    'terminal.terminateAll': z.object({}),
    'theme.importPath': z.object({ path }),
} as const;

export type InternalMethod = keyof typeof internalRequestSchemas;
export type RuntimeMethod = CaxriMethod | InternalMethod;

export function isCaxriMethod(value: string): value is CaxriMethod {
    return Object.hasOwn(requestSchemas, value);
}

export function getRuntimeRequestSchema(method: string) {
    if (Object.hasOwn(requestSchemas, method)) {
        return requestSchemas[method as keyof typeof requestSchemas];
    }
    if (Object.hasOwn(internalRequestSchemas, method)) {
        return internalRequestSchemas[method as keyof typeof internalRequestSchemas];
    }
    return undefined;
}

export const requestEnvelopeSchema = z.object({
    id,
    method: z.string().refine(isCaxriMethod),
    params: z.unknown(),
});

export type RuntimeEvent =
    | {
          event: 'runtime.status';
          payload: { status: 'ready' | 'restarting' | 'failed'; restartCount: number };
      }
    | { event: 'state.changed'; payload: { reason: string } }
    | {
          event: 'terminal.output';
          payload: { terminalId: string; data: string; droppedBytes?: number };
      }
    | { event: 'terminal.exit'; payload: { terminalId: string; exitCode: number; signal?: number } }
    | {
          event: 'files.changed';
          payload: { sessionId: string; changes: FileChange[]; overflow: boolean };
      }
    | { event: 'settings.changed'; payload: { source: string; error?: string } }
    | { event: 'keybindings.changed'; payload: { source: string; error?: string } }
    | { event: 'theme.changed'; payload: { source: string; error?: string } }
    | { event: 'command.execute'; payload: { command: string } };

export interface RuntimeResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}

export type RuntimeMessage = RuntimeResponse | RuntimeEvent;

export interface CaxriBridge {
    request<T = unknown>(method: CaxriMethod, params?: unknown): Promise<T>;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
