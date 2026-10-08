# Trevize (closed source)

_Researched 2026-08-06._

- **Positioning**: "Cloud agents for teams": gives each coding agent its own isolated cloud workspace (not the local machine), with a full preview environment and authenticated team access, so parallel agent work stops colliding across branches/services and stays visible to the whole team. Framed by users as a "multiplayer" workbench alongside multi-repo support.
- **Company/traction**: Small/solo-founder product built by Eelco Wiersma (@eelcodotdev, also known for the Saas UI React component library and Chakra UI docs work); previously operated under the name TervezoAI before rebranding to Trevize. No disclosed funding round found. Announced multi-repo support and "multiplayer agent sessions" in a July 2026 update (400k LoC shipped that week); Opus 5 support added late July 2026. Named alongside Orca, cmux, Conductor, T3 Code, Synara, Paseo, Jean, etc. in a 2026-08-05 X thread surveying agent workbenches (<https://x.com/T_Zahil/status/2085024540355166472>), with no distinct sentiment beyond the listing.
- **Tech stack**: Not disclosed publicly; no GitHub org/repo found. Product is a hosted web app (not a downloadable desktop client like Caxri/Kero/cmux).
- **License**: Closed source, commercial SaaS (Starter free tier, Team $50/mo, Scale $200/mo).

## Architecture highlights

- Each agent session gets a fully deployed preview environment: web/API/worker processes plus a Neon or Supabase database branch, spun up automatically per session and torn down after.
- "Blueprints" define multi-step agent runs: each step has a configurable prompt, harness, and model, plus a validation/pass condition; failing a check loops the run back to the relevant step instead of continuing, and once valid it opens a PR automatically.
- Runs are resumable: on provider rate limits or platform interruptions, Trevize waits/retries and continues rather than restarting; a "Steer" control lets a user pause a run, review progress, and redirect it mid-flight.
- Integrates with Linear, Slack, and Sentry as triggers (start work from an issue, thread, or new error) and with Neon/Supabase for preview database branching.

## Standout features

- Multiplayer/collaborative agent sessions with authenticated live-preview access for teammates, not just the agent's owner.
- Multi-repository, multi-process sessions (frontend + API + workers + every touched repo) versus single-repo-per-session tools.
- BYO API keys or Claude Max / OpenAI / Cursor Max subscriptions, with Trevize credits covering the cloud compute portion separately.

## Community sentiment

- Limited independent commentary found. Trevize appears only as a name-drop in the 2026-08-05 X thread (@T_Zahil) surveying agent workbenches, without replies discussing it specifically; repliers focused on Orca, Paseo, T3 Code, and Conductor instead.
