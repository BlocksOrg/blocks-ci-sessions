# Security

## What this action handles

- **`blocks_api_key`** is the only secret. It is registered with `core.setSecret` before
  anything else runs, so it is masked in logs, and it is sent only as an
  `Authorization: ApiKey` header to `api_base_url` (default `https://api.blocks.team`). It is
  never written to disk or exposed as an output.
- **Prompts and outputs** (`final_message`, `pull_requests`, and so on) are exposed as step
  outputs and written to the job summary. Treat them like any other workflow output: pass
  them through `env:` rather than interpolating `${{ }}` into `run:` blocks, and do not echo
  them into untrusted contexts.
- The action makes outbound HTTPS calls only to `api_base_url`. Links returned by the API are
  rebased onto that origin before they are followed, so a malformed or hostile API response
  cannot redirect a request to another host.

## Trust boundaries

- The runner executes the committed `dist/index.mjs`. CI fails any pull request where that
  bundle does not match `src/`, and `main` requires review, so what runs is what was reviewed.
- `@v1` is a floating tag that the release workflow moves on every release. Pin a full tag
  (`@v1.2.3`) or a commit SHA if you need the bundle frozen.
- What the agent does inside a session is governed by your Blocks workspace, its agent
  configuration, and the credentials it holds. This action only starts the session and waits
  for the result.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/BlocksOrg/blocks-ci-sessions/security/advisories/new)
rather than opening a public issue. Include a description, reproduction steps, and impact.
We aim to acknowledge reports within a few business days.
