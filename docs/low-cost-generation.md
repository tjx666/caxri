# Low-cost generation sandbox

Automatic Session naming and long-paste summaries are bounded text transformations. Their
provider subprocess cannot read the selected Project subtree or the provider's global instruction
files. Authentication and network access outside that boundary remain available.

Before launch, Server Core resolves the Project, executable, temporary working directory, and
provider configuration directory. A Project containing any required runtime location is rejected
with `sandboxBoundaryConflict`; Caxri does not add exceptions inside the denied subtree. Choose
a more specific Project folder instead of adding the home directory or a shared ancestor.

Both the instruction entry and its resolved target are denied. This covers `CLAUDE.md`,
`CLAUDE.local.md`, `AGENTS.md`, and `AGENTS.override.md`, including links into another directory.
Missing instruction files are allowed. Other resolution failures stop generation with
`sandboxPathUnavailable`; correct the paths or permissions and restart the Agent.

Automatic naming shows one notice and suppresses further attempts for that managed launch.
A new Agent launch can try again. A long paste keeps its original local file and includes the
specific failure reason in the path-only fallback. Neither flow logs prompts, model output,
instruction contents, or provider configuration paths.

This is a same-user, stable-configuration boundary. Resolving a link and subsequently launching
the provider is not an atomic filesystem transaction: another same-user process can still replace
a link between those operations. The sandbox also cannot predict future provider runtime paths;
unexpected required reads inside the Project fail closed.
