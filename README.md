# Blocks Agent Session

Starts a [Blocks](https://blocks.team) agent session from a GitHub workflow, waits for the
agent's final message, and exposes the session id so later jobs can chain off it.

```yaml
- id: review
  uses: BlocksOrg/blocks-ci-sessions@v1
  with:
    blocks_api_key: ${{ secrets.BLOCKS_API_KEY }}
    agent: claude
    prompt: Review pull request ${{ github.event.pull_request.html_url }}.

- run: echo "Session ${{ steps.review.outputs.session_id }} said ${{ steps.review.outputs.final_message }}"
```

See [`examples/`](./examples) for complete, copy-paste workflows.

## Setup

1. Create a workspace API key in the Blocks dashboard.
2. Add it as a repository or organisation secret named `BLOCKS_API_KEY`.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `blocks_api_key` | ✅ | — | Workspace API key. Masked in logs via `core.setSecret`. |
| `prompt` | ✅ | — | The message sent to the agent. |
| `agent` | | — | One of `claude`, `codex`, `gemini`, `opencode`, `cursor`, `kimi`, `sisyphus`. |
| `agent_id` | | — | UUID of a custom workspace agent. Mutually exclusive with `agent`. |
| `session_id` | | — | Resume: post `prompt` as a follow-up to an existing session. |
| `title` | | — | Session title, max 200 characters. Creation only. |
| `session_group_id` | | — | Group the session under an existing session group. Creation only. |
| `is_private` | | `false` | Hide the session from other workspace members. |
| `timeout_minutes` | | `30` | How long to wait for the final message. |
| `poll_interval_seconds` | | `5` | Seconds between polls. Minimum `1`. |
| `fail_on_timeout` | | `true` | `false` warns and continues instead of failing the step. |
| `api_base_url` | | `https://api.blocks.team` | Override the REST API base URL. |

### `agent` is effectively required

The action deliberately ships **no default agent**. A client-side default would silently
override whatever your workspace has configured, and it would disagree with the platform's
own fallback. `POST /rest/v1/sessions` currently requires one of `agent_name`, `agent_id` or
`profile` and has no workspace-default fallback, so in practice you must set `agent` or
`agent_id` on every run that creates a session.

If the API later gains a workspace-default fallback, omitting `agent` starts working on its
own — the action needs no change.

`agent`/`agent_id` are ignored when `session_id` is set; a resumed session keeps the agent it
was created with.

## Outputs

| Name | Description |
| --- | --- |
| `session_id` | The session id. **Set before polling begins**, so it survives a timeout. |
| `thread_id` | The thread this run created inside the session. |
| `final_message` | The agent's final message. Empty when the step timed out. |
| `session_html_url` | Link to the session in the Blocks dashboard. |
| `pull_requests` | JSON array of pull request URLs the session touched. |
| `status` | `completed` or `timed_out`. |

## Chaining jobs

Step outputs are step-scoped. To read one from another job, re-export it at job level:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    outputs:
      session_id: ${{ steps.review.outputs.session_id }}
    steps:
      - id: review
        uses: BlocksOrg/blocks-ci-sessions@v1
        with:
          blocks_api_key: ${{ secrets.BLOCKS_API_KEY }}
          agent: claude
          prompt: Review ${{ github.event.pull_request.html_url }}.

  autofix:
    needs: review
    runs-on: ubuntu-latest
    steps:
      - uses: BlocksOrg/blocks-ci-sessions@v1
        with:
          blocks_api_key: ${{ secrets.BLOCKS_API_KEY }}
          agent: claude
          prompt: |
            A PR review has run in the ${{ needs.review.outputs.session_id }} session.
            Fetch that session's transcript and fix every issue rated above 7/10.
            If there are none, stop immediately.
```

See [`examples/pr-review-autofix.yml`](./examples/pr-review-autofix.yml) for the full workflow.

`needs:` only runs the dependent job when the upstream job **succeeded**. If you want the
autofix job to run even when the review timed out, set `fail_on_timeout: false` on the review
step (the session keeps running on Blocks; you just stop waiting on it), or add
`if: always()` to the dependent job and branch on `needs.review.outputs.status`.

## Resuming a session

```yaml
- uses: BlocksOrg/blocks-ci-sessions@v1
  with:
    blocks_api_key: ${{ secrets.BLOCKS_API_KEY }}
    session_id: ${{ needs.review.outputs.session_id }}
    prompt: Also check the migration files.
```

A follow-up opens a **new thread** inside the same session, so `thread_id` differs from the
original run's. A follow-up also interrupts work that is still in flight.

## Rate limits and polling

The Blocks API allows **100 requests per minute per API key**, counted across every job using
that key. At the default `poll_interval_seconds: 5` a single step spends about 12 requests per
minute. Raise the interval when you fan out across a matrix.

Transient failures (`429`, `5xx`, dropped connections) are retried up to five times with full
jitter, honouring `Retry-After`. `400`/`401`/`403`/`404`/`409`/`422` fail immediately with the
API's own error message.

## Behaviour notes

- `session_id`, `thread_id` and `session_html_url` are published **before** the wait begins, so
  a timed-out or cancelled step still hands a usable session id to downstream jobs.
- The action polls the `_links.final_message` URL the API handed back, preserving its path and
  query. Only the origin is rebased onto `api_base_url`, because the API builds those links
  from its own environment-derived host.
- On success the final message and any touched pull requests are written to the job summary.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH`. Publishing a release moves the floating major tag
(`v1`) to that commit, so `@v1` tracks the latest compatible release. Pin a full tag or a commit
SHA if you need it frozen.

## Repository layout

`action.yml` sits at the repository root so the action can be listed on the GitHub Marketplace.

```
action.yml          action metadata
src/                TypeScript sources and unit tests
dist/               committed ESM bundle — this is what the runner executes
examples/           copy-paste workflows
scripts/            build script and the mock API used by the end-to-end CI job
.github/workflows/  CI (lint, types, tests, dist drift, e2e) and release tagging
```

## Development

Node 24 and npm.

```bash
npm ci
npm run lint
npm run type-check
npm run test
npm run build   # regenerates dist/index.mjs — commit the result
npm run all     # all of the above
```

`dist/index.mjs` is committed because the runner executes it directly. CI fails the PR if it
drifts from the sources.
