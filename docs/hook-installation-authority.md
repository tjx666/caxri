---
kind: living
status: current
---

# Hook installation authority

Provider settings are shared by Caxri profiles. A profile's requested enablement is durable intent;
executable discovery only determines its current ability to install, repair, or activate hooks.
Losing CLI availability preserves intent and existing configuration, reports the installation hint,
and cannot authorize writes on behalf of another profile. Explicitly disabling the last profile,
or confirming that its profile directory was removed, permits cleanup of current or older entries.

The shared registry and existing installation lock coordinate removal. They do not grant install
or repair rights: those require this profile to enable the provider and resolve its CLI. An absent,
stale, or edited global configuration remains untouched by a locally disabled or unavailable
profile, even when another profile requests that provider.

A newer schema is never downgraded or removed by this build. Its required event, matcher, phase,
and reply bindings must still cover this build's lifecycle contract. Additional future fields or
events are allowed. Missing coverage reports an incompatible installation with a repair direction
to the newer build; receiving a remaining hook cannot turn that health Active. A complete newer
installation remains usable through the existing launch-scoped protocol.

Installed health states retain the schema version. Health transitions log that version when known
and a hashed profile identifier, never the profile path or provider configuration contents.
