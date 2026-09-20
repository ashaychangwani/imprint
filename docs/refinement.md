# Repair or extend an installed tool

```sh
imprint refine my-site --tool search --issue "Repair missing result entries" \
  --from-session /path/to/recording.json --provider codex-cli --timeout 30m
imprint audit my-site --strict
```

`refine` uses existing artifacts and a recording, skips discovery, and asks an agent to select the target and necessary existing dependencies. It supports repairs and explicitly requested additive capabilities. Existing parameter names, types and accepted choices are preserved; new parameters require defaults for existing callers. The first version supports data tools without irreversible effects, with `codex-cli` or `claude-cli`. Authentication programs still require teaching.

When `--from-session` is omitted, Imprint uses the newest recording retained under the site; it fails with a request for an explicit recording if none exists. A recording that cannot establish the requested behavior is insufficient evidence, not permission to invent support.

Work runs in an isolated staging home under `IMPRINT_HOME/.refine-runs/<id>`. A fixed set of recording-backed calls checks both recorded parser output and comparable fresh responses. Dependent inputs come from new producer outputs. A strict audit of the staged site must also pass. The 30-minute default is shared by compilation, verification and audit; `--timeout` changes that deadline. No automatic recurring job is created.

Only verified replacements are installed. A concurrent edit to an original artifact prevents replacement; promotion errors restore originals. Hidden `.refine-backup-*` directories retain previous versions, and failed runs preserve staging and reports. Promotion of several tools is rollback-protected, not an atomic snapshot for already-running readers; reconnect an MCP client after refinement.

`audit --strict` requires no broken invocations or parameters and no missing/unverified coverage. The usual numeric score remains visible, but cannot override these requirements. Infrastructure exclusions, bad-input attempts and untestable parameters make strict coverage inconclusive. Without `--strict`, the existing threshold behavior remains available.

The changes add stronger checks; they do not themselves prove repeatable teaching. Record fresh teach results, independent audit counts, supported scope, failures, timings and usage before claiming an improvement.

Fresh teaches retain their selected live inputs and producer bindings in `.verification-plan.json`. Independent audits use that fixed case list, refresh only expired values, and report each `caseId`. Strict audits remain inconclusive when any selected case lacks a correct invocation. The sidecar contains inputs and provenance, not the evidence reader's expected answers.

Refinement keeps the previously retained cases and adds the repair or extension cases to that strict audit. This preserves the existing recorded acceptance coverage alongside the requested change. New API plans must declare paired recording/live response chains before compilation starts.
