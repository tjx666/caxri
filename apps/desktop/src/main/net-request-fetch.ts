import type { IncomingMessage } from 'electron';
import { net } from 'electron';

import type { ManualRedirectFetch, ResolveHost } from './public-https-fetch';

/**
 * Statuses whose response must not carry a body; `Response` rejects one.
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The request was aborted', 'AbortError');
}

function responseHeaders(message: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(message.headers)) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) headers.append(name, item);
    }
    return headers;
}

/**
 * Streams a response body to a web `ReadableStream`. Cancelling it, or the request being aborted mid-body, ends the
 * request so a capped reader never keeps downloading.
 */
function responseBody(
    message: IncomingMessage,
    request: Electron.ClientRequest,
): ReadableStream<Uint8Array> {
    let isDone = false;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const finish = (error?: Error) => {
                if (isDone) return;
                isDone = true;
                if (error) controller.error(error);
                else controller.close();
            };
            message.on('data', (chunk) => {
                if (!isDone) controller.enqueue(new Uint8Array(chunk));
            });
            message.on('end', () => finish());
            message.on('error', (error) => finish(error));
            message.on('aborted', () => finish(new Error('The response was aborted')));
            // An aborted request destroys the message without `end`; a reader must not wait for a body that stopped.
            (message as unknown as NodeJS.EventEmitter).on('close', () =>
                finish(new Error('The response closed before its end')),
            );
        },
        cancel() {
            isDone = true;
            request.abort();
        },
    });
}

/**
 * A `ManualRedirectFetch` over Electron's `net.request`, so the system proxy and Chromium's HTTP cache apply.
 * `net.fetch` cannot serve here: with `redirect: 'manual'` it rejects on the redirect without exposing its target, so a
 * caller could not vet where a redirect leads. A redirect is answered as a body-less response carrying `location`, and
 * the request ends there. Session cookies are not sent: these requests happen without a click, and a cookie must not
 * turn a hover into an authenticated action.
 */
export const netRequestFetch: ManualRedirectFetch = (url, init) =>
    new Promise<Response>((resolve, reject) => {
        if (init.signal.aborted) {
            reject(abortReason(init.signal));
            return;
        }
        const request = net.request({ url, method: 'GET', redirect: 'manual' });
        const headers = Object.entries(init.headers ?? {});
        for (const [name, value] of headers) request.setHeader(name, value);
        init.signal.addEventListener(
            'abort',
            () => {
                request.abort();
                reject(abortReason(init.signal));
            },
            { once: true },
        );
        request.on('redirect', (statusCode, _method, redirectUrl) => {
            // Aborting inside the listener, instead of calling `followRedirect`, ends the request without an error.
            request.abort();
            resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
        });
        request.on('response', (message) => {
            try {
                resolve(
                    new Response(
                        NULL_BODY_STATUSES.has(message.statusCode)
                            ? null
                            : responseBody(message, request),
                        { status: message.statusCode, headers: responseHeaders(message) },
                    ),
                );
            } catch (error) {
                request.abort();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        request.on('error', reject);
        request.end();
    });

/**
 * Resolves a hostname through Chromium's resolver, the one `net.request` connects with, so the vetted addresses are the
 * ones the request uses (DNS over HTTPS and the hosts file included).
 */
export const netResolveHost: ResolveHost = async (hostname) =>
    (await net.resolveHost(hostname)).endpoints.map((endpoint) => endpoint.address);
