/**
 * Minimal CDP client for inspecting a running Caxri Renderer, shared by the skills that attach over the
 * `remote-debugging-port` endpoint (`acceptance` capture, `audit-ux` render counting). It intentionally carries no
 * ownership, lease, or fixture policy: each caller keeps its own authorization rules and passes an already resolved
 * port.
 */
const CDP_TIMEOUT_MS = 10_000;

export interface CdpTarget {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

export interface CdpConnection {
    close(): void;
    request<T>(
        method: string,
        parameters?: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<T>;
}

/**
 * Whether a page is the main window of an unpackaged dev launch: the Vite dev-server root or its `index.html`.
 * Secondary windows load sibling entries (`agent-commander.html`, `process-explorer.html`) from the same server.
 */
function isDevelopmentMainPage(url: string): boolean {
    try {
        const { pathname, protocol } = new URL(url);
        return (
            (protocol === 'http:' || protocol === 'https:') && /\/(?:index\.html)?$/.test(pathname)
        );
    } catch {
        return false;
    }
}

/**
 * Picks the single main-window Renderer target. A packaged or built launch exposes `<app>/out/renderer/index.html` next
 * to secondary windows such as the Process Explorer; an unpackaged dev launch exposes the Vite dev-server root next to
 * the same secondary entries served by Vite. Without a built page the dev root wins, and only a launch with neither
 * falls back to every page. DevTools windows are never candidates: attaching to one silently inspects the inspector.
 */
export function selectRendererTarget(targets: CdpTarget[], urlContains?: string): CdpTarget {
    const pages = targets.filter(
        (target) =>
            target.type === 'page' &&
            Boolean(target.webSocketDebuggerUrl) &&
            !target.url.startsWith('devtools://'),
    );
    const mainRendererPages = pages.filter((target) =>
        /\/out\/renderer\/index\.html(?:[?#]|$)/.test(target.url),
    );
    const rendererPages = pages.filter((target) => target.url.includes('/out/renderer/'));
    const developmentMainPages = pages.filter((target) => isDevelopmentMainPage(target.url));
    const candidates = urlContains
        ? pages.filter((target) => target.url.includes(urlContains))
        : ([mainRendererPages, rendererPages, developmentMainPages].find(
              (group) => group.length > 0,
          ) ?? pages);
    if (candidates.length !== 1) {
        const urls = pages.map((target) => target.url).join(', ') || 'none';
        const selector = urlContains ? ` matching "${urlContains}"` : '';
        throw new Error(
            `Expected exactly one Caxri Renderer CDP target${selector}; available: ${urls}`,
        );
    }
    return candidates[0];
}

class CdpClient implements CdpConnection {
    static async connect(url: string): Promise<CdpClient> {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                socket.close();
                reject(new Error(`Timed out connecting to ${url}`));
            }, CDP_TIMEOUT_MS);

            function cleanup(): void {
                clearTimeout(timeout);
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
            }

            function onOpen(): void {
                cleanup();
                resolve();
            }

            function onError(): void {
                cleanup();
                reject(new Error(`Unable to connect to ${url}`));
            }

            socket.addEventListener('open', onOpen, { once: true });
            socket.addEventListener('error', onError, { once: true });
        });
        return new CdpClient(socket);
    }

    private nextId = 1;
    private readonly pending = new Map<
        number,
        { reject: (error: Error) => void; resolve: (value: unknown) => void }
    >();

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data)) as {
                error?: { message: string };
                id?: number;
                result?: unknown;
            };
            if (message.id === undefined) return;
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
        });
        socket.addEventListener('close', () => {
            for (const request of this.pending.values()) {
                request.reject(new Error('CDP connection closed'));
            }
            this.pending.clear();
        });
    }

    close(): void {
        this.socket.close();
    }

    async request<T>(
        method: string,
        parameters: Record<string, unknown> = {},
        timeoutMs = CDP_TIMEOUT_MS,
    ): Promise<T> {
        const id = this.nextId++;
        const result = new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
            });
        });
        this.socket.send(JSON.stringify({ id, method, params: parameters }));
        return (await result) as T;
    }
}

export async function connectToRenderer(
    port: number,
    urlContains?: string,
): Promise<CdpConnection> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
    const target = selectRendererTarget((await response.json()) as CdpTarget[], urlContains);
    if (!target.webSocketDebuggerUrl) throw new Error('Renderer target has no WebSocket URL');
    return CdpClient.connect(target.webSocketDebuggerUrl);
}

/**
 * Attaches to a Node Host inspector (Server Core 9229, Extension Host 9230, Terminal Host 9231 by default). Each Host
 * process exposes exactly one `node` target.
 */
export async function connectToNodeInspector(port: number): Promise<CdpConnection> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Inspector discovery failed with HTTP ${response.status}`);
    const target = ((await response.json()) as CdpTarget[]).find(
        (candidate) => candidate.type === 'node' && candidate.webSocketDebuggerUrl,
    );
    if (!target?.webSocketDebuggerUrl) throw new Error(`No Node inspector target on port ${port}`);
    return CdpClient.connect(target.webSocketDebuggerUrl);
}
