# Consolidation Prompt Template

Replace `{confirmed_findings}` after all verifier overrides have been applied.

````text
Consolidate duplicate confirmed Caxri review findings. Do not re-verify, rewrite, or change severity,
likelihood, evidence, or fixes.

{confirmed_findings}

Two findings share a root only when one concrete fix resolves both. Similar files, processes, or
themes are insufficient. Keep the earliest finding as the root and return only later duplicates.
Never invent ids, map an id to itself, create cycles, or merge findings requiring separate fixes.

Return one valid JSON object in one `json` fence:

```json
{
  "same_root": [
    { "id": "life-2", "same_root_as": "logic-1" }
  ]
}
```

Return `{"same_root":[]}` when no roots are shared.
````
