# Package boundaries and Server composition

Related contracts: [IPC](ipc.md) defines the method table and dispatcher contract used by the
Server composition root below.

`packages/system` stays free of product domain state and native Desktop dependencies. It owns
reusable process, filesystem, observability, build, and test-harness primitives for non-browser
consumers.

`packages/utils` is browser-safe and free of runtime dependencies. It holds pure functions only.
Domain types, protocol schemas, and React code never move there.

Application source cannot import bundled implementation under `extensions/`; consume the public
Extension API and Host protocol. Repository build tooling may compose extension artifacts.

`packages/mobile-transport` is the browser-safe cryptographic and wire-format boundary shared by
native mobile clients and the Server gateway. It cannot import Node.js, Electron, native Desktop
packages, `@caxri/protocol`, or application source. Its public package root is the only supported
entrypoint. Version 2 sealed application frames separate correlated replies, subscription events,
terminal streams, and heartbeats. The transport package validates the outer frame and resource
shape; nested command requests and replies remain `unknown` there and are validated immediately by
`@caxri/protocol` at each Server or mobile application boundary. The client owns one authenticated
reader and routes replies by request ID, while only foreground visible views hold subscriptions.
Device revocation first fences the stored Server generation, then sends a generation-bound `revoked`
control payload only through each already authenticated encrypted session before disconnecting it. The
mobile client clears its credential only after that sealed payload authenticates. The frozen
`update-recovery-v1` exchange is the one wire contract that must never follow a transport version
bump: it keeps its own schemas and crypto so a phone refused as outdated can still prove its pairing
and fetch the Desktop's Android build. A reconnect whose
stored credential cannot authenticate remains indistinguishable from an invalid credential or fake
endpoint, so it retains the credential, stops automatic retry, and asks the user to retry or forget it.

`apps/mobile` is the Expo and React Native companion application. Its `app/` and `src/` runtime graph
may import only `@caxri/mobile-transport` and `@caxri/protocol`; tests may additionally consume
browser-safe pure utilities. Runtime type-checking exposes only ECMAScript plus worker-safe Web APIs,
excluding both Node.js ambient types and browser document/window globals that React Native does not
provide. Node-powered Expo plugins and build scripts remain outside that runtime configuration.

Server Core resolves that table through one composition root. `createServerDomainService(deps)`
constructs and wires every domain service from injected dependencies (data directory, logger, event
sink, and Terminal/Agent seams) and returns an exhaustive handler table plus one disposal path. The
Server Core entrypoint therefore owns composition and transport only, while the request surface remains
exercisable in-process without Electron. One dispatcher validates each request, invokes its handler,
records the request boundary, and classifies failures.

Server domain placement follows one scale rule: a domain may remain flat while it has at most two
production modules; at three or more cohesive modules it owns `apps/server/src/domains/<domain>/`,
exposes its boundary through `index.ts`, and keeps tests in that directory's `__tests__/`. Git,
Terminal, Agents, Files, and DB use this nested shape. Production cross-domain imports stay relative
and target only the domain root; a focused structure test rejects a missing barrel or deep cross-domain
import. The same test enforces both flat shapes the rule forbids: a flat `domains/<prefix>-*.ts` module
beside an existing `domains/<prefix>/` directory, and a third flat module sharing one first hyphen
segment. Pre-existing exceptions sit in its frozen allowlists, which may only shrink.
