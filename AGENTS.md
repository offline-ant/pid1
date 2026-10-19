# Development instructions

Generic guidance adapted from the Lace workspace's `AGENTS.md`; workspace-specific rules and references are omitted.

## Reading and documentation

- Before changing a project, read its instructions and required documentation.
- Resolve paths relative to the document's original source directory.
- Read required documents completely; headings and sampled passages do not establish which mechanisms already exist. Documents already present in full need not be reread solely to load another copy. Say which documents you read in full, and report discrepancies rather than inventing undocumented behavior.
- Keep each rule and technical subject in its owning document. Reference that source instead of maintaining another explanation, API copy or file map.

## Development principles

- Optimize for the smallest clean long-term design. Treat the cost of change as zero; there are no users or legacy state to preserve.
- Question whether every line needs to exist. Code and prose not written cannot be wrong. Delete stale or unnecessary material instead of preserving it, annotating it, deprecating it, or describing it as updated or corrected.
- Implement direct final states. Do not add compatibility code, obsolete-format parsers, aliases, migration paths, shims, or parallel mechanisms unless explicitly requested.
- Do the hard part first. Add a choice, mechanism, abstraction, or defensive branch only after its need is established. Keep straightforward solutions without worsening asymptotic complexity.
- When failure is a valid contract outcome, prefer prompt, explicit failure and the existing terminal cleanup path over special cases that keep uncertain or partially failed work alive. Make that failure path settle owned resources and preserve the original and independent cleanup errors. Add recovery only when the contract requires it; do not turn uncertainty into success.
- Rename unclear concepts to match their actual role.
- Ask before inventing terminology, compatibility behavior, authority boundaries, or cross-layer ownership cuts.

## Style, tests and working discipline

- Read files before changing them.
- Keep prose technical and concise. Start major docs with what they enable.
- Use normative `MUST` language only in numbered protocol contracts.
- Keep source files under a soft 1000-line cap; split before 1500 lines.
- Put tests in test files and prefer boundary-crossing contract tests.
- Use explicit tiny limits in resource-limit tests.
- Each test finishes within 20 seconds; only a test whose subject is volume or duration may take longer, marked big and excluded from the default run. Do not wait out fixed deadlines: inject tiny limits or a paused clock. Test commands keep a timeout of at most 60 seconds as a hang backstop; apply any stricter project limit.
- Use `uv` for Python dependency, environment, build, and test work.
- Do not run destructive git commands without explicit approval.
- Multiple agents may work concurrently; touch only task-relevant files.
- Create git worktrees under the workspace's ignored `worktrees/` folder and remove them when their work is merged or abandoned.

## Agent behavior

- Don't trust assumptions when verifiable information exists. Assess confidence before acting.
- If a request is ambiguous, ask clarifying questions before doing anything.
