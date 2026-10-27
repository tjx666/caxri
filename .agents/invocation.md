# Contributor Skill Invocation

Contributor skills have one of two invocation roles: explicit-only entry workflows that a person
starts, and model-invoked disciplines that another skill or ordinary coding task may load.

## Explicit-only entry skills

<!-- explicit-only-skills:start -->

- `grill-me`
- `grill-with-docs`

<!-- explicit-only-skills:end -->

Every skill in this list must pair `disable-model-invocation: true` in `SKILL.md` with
`policy.allow_implicit_invocation: false` in `agents/openai.yaml`. Skills outside the list must not
carry either opt-out. `commit` deliberately remains model-invoked so an ordinary request to commit
still routes correctly.

## Cross-skill calls

- A skill that another workflow calls must remain model-invoked. This includes `competitors`,
  `file-issue`, `deep-review`, `acceptance`, and `pull-request`.
- Write executable cross-skill instructions as `Call the Skill tool with "skill-name"`. Name each
  requested skill when more than one is required.
- Never call an explicit-only entry skill from another skill. Human-facing `$skill-name` or
  `/skill-name` labels in routing prose and documentation are not executable cross-skill calls.

The explicit-only list in `scripts/__tests__/skill-invocation.test.ts` is the executable authority.
The test keeps this document, every frontmatter flag, and every OpenAI policy in sync.
