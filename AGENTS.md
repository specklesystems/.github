# .github

Shared GitHub workflows and actions that Speckle repos call at a pinned commit, plus the org profile.

## What lives here

- `.github/workflows/<name>.yml`: the reusable workflows other repos call
  (`secret-scan`, `risk-check`, `risk-check-review`, `image-scan`), and
  `risk-check/`, the action behind the risk check. `<name>-test.yml` runs
  one on a pull request here; `<name>-self.yml` runs it on this repo.
- `profile/README.md`: the public org profile page.

The repo is public. Every change needs an `engineering` approval
(ruleset 27554748).

## How a change reaches the callers

Callers pin a commit of this repo
(`specklesystems/.github/.github/workflows/<name>.yml@<sha>`); find them
by searching the org's workflows for `specklesystems/.github/`.

1. A merge to `main` gets the next tag `v1.<n>.0` (`tag-release.yml`).
2. Dependabot in each caller (`.github/dependabot.yml`, ecosystem
   `github-actions`, group `dot-github`) opens the pin update with the
   compare view: `speckle-next` on its next daily run, every other caller
   after a 3-day cooldown. Do not open pin updates by hand, unless a fix
   cannot wait for them. Rules: ADR-0002 in the atlas,
   `atlas/specs/2026-11-change-gate-rollout/adr/0002-shared-risk-check-lives-in-dot-github.md`.
3. A new caller adds that `dependabot.yml` entry when it first pins this
   repo.

Inputs, secrets, job names and artifact names are the contract with the
callers: a pin update must not need a change in the caller. Add an input
as optional with a default; to remove or rename one, change the callers
first. The atlas findings review reads the `image-scan` artifact and the
job `Scan`.

## Agent config (ADR-0008)

Tracked sources: this file, repo-local `agents/skills/` and `agents/mcp/`
(when the repo has any), the hooks `.claude/settings.json` +
`.codex/hooks.json`, and omp's `.omp/extensions/atlas-sync.js`.
`.claude/skills/`, `.agents/skills/`, `.mcp.json`, `.codex/config.toml` and
the block below are written by `../atlas/scripts/sync-agents.py` (session
start, `mise run agents-sync` at the atlas root) — edit the source, never the
output. Layout, opt-in shared MCP servers and collision rules:
`../atlas/agents/README.md`.

<!-- atlas:shared:begin -->

<!-- Duplicated from the atlas checkout root AGENTS.md by atlas/scripts/sync-agents.py for clients that stop at this repo's git root (Codex, Grok). Edit the atlas copy. -->

# Code comments: decision significance only

Write a comment only when it states a decision or constraint the code
cannot show — the why behind a non-obvious choice, with the ticket, spec,
or ADR reference when one exists. Never write comments that:

- describe the current state of the world elsewhere ("the chart ignores
  this value for now", "X hasn't landed yet") — they go stale silently
  the moment that other thing changes;
- retell the spec, plan, or PR narrative — reference the ticket instead;
- explain what the next line does.

That context belongs in the commit message, PR body, or ticket. This
policy overrides matching the comment density of the surrounding file:
a legacy heavy-comment file does not license new narrative comments.

# Ticket workflow: claim before you code

When starting implementation of a Linear ticket — via /implement, /tdd, or
no skill at all — first claim it:

1. Move the ticket to **In Progress**.
2. Assign it to the developer running the session (`linear-server`
   `get_user` with query "me").

If the ticket is already In Progress and assigned to someone else, stop
and confirm with the user before touching it — it may be claimed by a
parallel session, and double-resolving a claimed ticket has burned us
before.

This applies only to work tracked as a Linear ticket; untracked work and
repo-local trackers with their own conventions are unaffected. Claiming is
the only transition this rule owns — later states (review, done) belong to
the PR flow.

# UI scope: build what was asked

When a change touches UI, build what the person asked for. Everything else you notice (a tidier header, a chart, a new panel, a renamed route) goes in the hand-back as a one-line suggestion. When the repo has a product page (frontend-3: `packages/frontend-3/docs/product/why.md`), read it first.

When the person approves a list in one go ("do everything"), answer once before building: each item's user job, and what outside the app could break (links, public APIs, other repos). Build on their next go, and quote what they asked for under **Asked in chat** in the PR body.

# User-facing copy

Apply this standard across product messages, help, documentation, support
replies, investigation summaries, release notes, and digests. Match the
reader's knowledge while keeping the facts precise.

- Name the public product, feature, or setting the reader can find. Verify
  the name in the relevant public documentation or released interface.
  Internal project names, repository names, staff names, and test-account
  references do not establish public names or compatibility requirements.
- Separate schema or format versions from application releases, dependency
  versions, and deployment environments. Verify each identifier against its
  owner: the versioned schema or specification, the published release and
  tagged source, the dependency manifest, or deployment evidence. A package
  pin proves a dependency version, not that a feature reached customers.
- When compatibility determines the next step, name the affected component
  and the exact verified release or schema boundary. Avoid "old", "new",
  "latest", or "legacy" as the only distinction. Do not infer a boundary for
  every connector, platform, or server from one component's release.
- State what happened, what the reader can do next, and the condition for
  that action to work. Explain necessary technical terms once. Keep exact
  public function names, error codes, and version identifiers when the
  reader needs them to act; plain language must not erase those facts.
- Keep an authoritative source with each version, availability, or naming
  claim in the review evidence. Link it in support replies or documentation
  when useful; product messages need not contain the research trail.
- If evidence is missing or conflicting, do not invent a name or number.
  In interactive work, request the missing evidence. In constrained or
  headless work, use only the permitted inputs, omit unsupported claims,
  and record any unresolved fact in the internal report. Treat a customer's
  wording or a merged PR as a report, not proof of a public release.

Use the same verified public name and meaning across domains. Resolve
conflicts against the owning source rather than copying internal glossary labels into user-facing text. Keep raw diagnostic
queries, identifiers, and staff context in the appropriate internal report;
prepare a separate reader-facing explanation when needed.

# Ways of working (Speckle stack)

When the user starts describing a feature, refactor, bug, or plan, suggest
the matching entry point instead of diving into implementation: `/wayfinder`
for big/foggy multi-session work, `/grill-me` (or `/grill-with-docs`) to
stress-test one plan, `/prototype` when "how should it look/behave" is open,
then `/to-spec` → `/to-tickets` → `/implement`. Opening a PR or marking a
draft ready, whatever the entry point: load the `pr` skill first. The full loop:
`atlas/ways-of-working.md` in the speckle-atlas checkout root
(`../atlas/ways-of-working.md` from this repo in the standard nested layout)
— read it before shaping non-trivial work.

Specs: cross-repo → the atlas repo's `atlas/specs/`; local to this repo →
this repo's `specs/` folder. Same structure everywhere: `YYYY-MM-title.md`,
a linked Linear project, worked via PR. Check both places when picking up
spec work.

ADR linking is two-way (atlas ADR-0003 + its amendment): a repo-local ADR
born from a cross-repo project back-links the owning atlas spec in its
header and is indexed from that spec; and when a stack-level ADR — standing
(`atlas/adr/`) or a spec's — governs a specific module of this repo, that
module carries a **pointer ADR** in its local ADR home. A pointer is a thin
stub, never a fork of the atlas content: it keeps the atlas ADR's number and
title, names the atlas text as canonical, links it and its spec by relative
path (never GitHub URLs), summarizes the decision and what it binds in this
module, and is registered in the module's docs index and the repo's context
map. The pointer lands with the work that makes the decision bind the
module. If a pointer's atlas links don't resolve, this checkout is missing
the atlas layer — ask the user to set up the speckle-atlas checkout above
this repo before acting on that decision.

Shared skills, MCP definitions, and conventions change **in the speckle-atlas
repo via PR** — never by editing synced outputs (`.agents/skills`,
`.claude/skills`, `.mcp.json`, `.codex/config.toml`, this block) or forking a
local copy in this repo. A repo-local skill with a shared skill's name fails
the sync (ADR-0008); there is no override.

<!-- atlas:shared:end -->
