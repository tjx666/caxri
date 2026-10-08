# caxri

Type declarations and runtime stubs for the Caxri extension API.

An extension imports this package to get the `caxri` namespace and its types. The published build
carries the full type surface but no working implementation: every method throws
`CaxriApiUnavailableError` (`code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST'`) when it is called outside
Caxri. The real implementation is injected by the Extension Host at load time, replacing these
stubs.

That split is deliberate: it lets an extension be type-checked, bundled, and unit-tested with
ordinary Node tooling, while making it obvious at runtime when code that expects the Host is running
somewhere else.

```ts
import { Disposable } from 'caxri';

export function activate(): Disposable {
  return new Disposable(() => {
    // Release whatever the extension registered.
  });
}
```

## What it covers

- Source control view providers: groups, resources, actions, history pages, and their decorations.
- Workspace Git reads: repository summary, status, commits, commit details, and pull request changes.
- `Disposable` and the glob matcher used by the Host's path settings.

`docs/extensions.md` in the repository describes the extension model, how the Host loads an
extension, and what capabilities it must declare.

## Versioning

The API tracks the Caxri desktop application and is pre-1.0. Breaking changes ship in minor
versions until the first public release.

## Source

<https://github.com/tjx666/caxri/tree/main/packages/extension-api>
