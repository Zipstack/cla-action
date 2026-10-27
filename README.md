# cla-action

A GitHub Action that enforces the Zipstack Contributor License Agreement (CLA) on pull requests. It replaces cla-assistant.io with something that runs on GitHub Actions and depends on no external service.

## How it works

On every pull request, and on every new PR comment:

1. It lists the PR's commit authors, plus the PR author.
2. Each of them passes if they have already signed, are a bot or on the allowlist, or are a member of the organization.
3. It sets a commit status (`license/cla` by default) on the PR head: `success` when everyone passes, `failure` otherwise. **Make this status the required check.**
4. When someone still needs to sign, it posts one comment on the PR naming them and giving the exact phrase to post. It edits that same comment as things change, instead of adding new ones.
5. When a commit author or the PR author has posted the phrase in a comment on the PR, it records their signature. Any comment re-runs the check; the PR comment suggests `recheck`.

Every run reads all of the PR's comments for signatures, not just the comment that triggered it. The workflow's concurrency group keeps one pending run per PR and cancels the one already pending, so a sign comment's own run may never execute; the next run records it instead.

The PR author is checked even without commits of their own. Commit authors are matched by the commit's email address, which the committer chooses, so without that a contributor could attribute every commit to an exempt or already-signed account.

GitHub lists at most 250 commits of a pull request. A PR with more fails the check and asks to be split, rather than passing on a partial list.

A signature covers every repository that uses the same signatures file, so a contributor signs once.

### Where signatures live

Signatures are stored in one JSON file (`signatures.json`) in a private repository, which the action reads and writes through the GitHub contents API:

```json
{
  "version": 1,
  "signatures": [
    {
      "id": 583231,
      "login": "octocat",
      "signed_at": "2026-10-27T10:00:00.000Z",
      "cla_document": "https://gist.github.com/...",
      "repository": "Zipstack/unstract",
      "pull_request": 2373,
      "comment_url": "https://github.com/Zipstack/unstract/pull/2373#issuecomment-..."
    }
  ]
}
```

Signers are matched by numeric GitHub user id, so renaming an account doesn't invalidate a signature. Each write includes the file's current blob sha, so two signatures recorded at the same moment can't overwrite each other: the later write is rejected, re-reads the file and retries.

## Setup

1. **Signatures repository.** Create a private repository (e.g. `Zipstack/cla-signatures`). The action creates `signatures.json` on the first signature.
2. **GitHub App.** Create an app owned by the organization with these permissions:
   - Repository → Contents: **Read and write**, installed on the signatures repository only.
   - Organization → Members: **Read**, needed when `exempt-org-members` is on.

   Store its id as the organization variable `CLA_APP_ID` and its private key as the organization secret `CLA_APP_PRIVATE_KEY`.
3. **Workflow.** Copy [`examples/cla.yml`](examples/cla.yml) to `.github/workflows/cla.yml` in each repository that requires the CLA.
4. **Branch protection.** Require the `license/cla` status. If the repository used cla-assistant.io, it already requires that context. Unlink the repository from cla-assistant.io first, so the two don't both set the status.

### Why `pull_request_target`

PRs from forks don't get secrets under `pull_request`, and the action needs a token for the signatures repository. `pull_request_target` runs in the context of the base repository, so it gets the token. That is safe only because the workflow never checks out or runs the PR's code, so **never add a checkout step to this workflow.**

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `cla-document-url` | — (required) | Link to the CLA text. |
| `signatures-repository` | — (required) | `owner/name` of the signatures repository. |
| `signatures-token` | — (required) | Token with contents read/write on the signatures repository, plus organization members read. |
| `signatures-path` | `signatures.json` | Path of the signatures file. |
| `signatures-branch` | `main` | Branch to read and write. |
| `sign-phrase` | `I have read the CLA Document and I hereby sign the CLA` | Comment that signs. Case, whitespace and a trailing full stop are ignored. |
| `allowlist` | `*[bot]` | Comma-separated logins that never need to sign. `*` is a wildcard. |
| `agent-logins` | `claude` | Coding-agent accounts whose commits count as the PR author's (see below). |
| `exempt-org-members` | `true` | Skip members of the organization. |
| `organization` | repository owner | Organization whose members are exempt. |
| `status-context` | `license/cla` | Name of the commit status. |
| `github-token` | `${{ github.token }}` | Token for the calling repository. The workflow must grant `pull-requests: write` and `statuses: write`. |

## Commits that can't be signed

A commit whose author email isn't linked to any GitHub account has no GitHub user, so nobody can sign for it. The PR comment lists those commits by short sha and author name (never by email), and the check stays failing until the author links the email to their account or amends the commits.

## Commits made by coding agents

When Claude Code is itself the commit author (for example in a Claude Code cloud session), the commit is authored by `noreply@anthropic.com`, which GitHub links to the account `claude`. A local Claude Code session usually commits as the developer and names Claude only in a `Co-Authored-By` trailer, which the action does not read. The `claude` account can't sign anything on the contributor's behalf, so commits from any login in `agent-logins` are attributed to the PR author, and the PR author signs for them. Org members stay exempt as usual. Don't put agent accounts on the `allowlist`: that would let anyone skip the CLA by having the agent make every commit.

## Known limitations

- **A run that errors posts no status.** The required check then stays pending, and the error is only in the workflow run. API calls have no timeout or retry; only the signatures write is retried, and only on a 409 or 422 response, up to 5 attempts.
- **A missing signatures file reads as "nobody has signed yet",** and an organization the token can't see reads as "not a member". A misconfigured repository, path, branch or organization therefore asks everyone to sign rather than failing with a configuration error.
- **A sign comment that is not accepted gets no reply on the PR** (for example from someone who is neither a commit author nor the PR author). The reason is only in the workflow log.
- **A signature is not tied to a CLA version.** Any signature in the file counts for every repository and every `cla-document-url`. Records from the importer carry `cla_version`; records from the action don't.
- **The PR comment is found by its marker alone**, whoever wrote it, and an unlinked commit's author name is shown as the committer wrote it.
- **The signatures file must stay under 1 MB** (a few thousand signatures): above that the contents API stops returning the file and every run fails.
- **`exempt-org-members` is off only for the exact value `false`.** Any other value, including `False` or `no`, leaves org members exempt.
- **A PR opened by an account in `agent-logins` fails the check** unless that account itself signs or is an org member, because it counts as the PR author. The action does not stop an agent account from signing. Open the PR from a person's account, or from a GitHub App (`[bot]` accounts are exempt).
- **An edited or hidden comment never signs**, even when its author edited it into the phrase or a maintainer only hid it; the person posts the phrase again as a new comment. The workflow log says which comment was ignored. This is checked when the signature is recorded, normally seconds after the comment is posted: editing or hiding a comment afterwards does not remove a signature already recorded, and nothing in the action does.
- **The status description counts unlinked commits** as committers, one per commit.
- **The file's `version` field is not checked** when it is read.

## Migrating from cla-assistant.io

1. Log in at [cla-assistant.io](https://cla-assistant.io) with an account that has push access to the linked repository. Open the repository's signature report and download **Complete History as JSON**.
2. Convert it:

   ```sh
   GITHUB_TOKEN=$(gh auth token) node scripts/import-cla-assistant.js cla-assistant.json > signatures.json
   ```

   The script resolves each login to its GitHub user id, skips revoked signatures, keeps the earliest signature per person, and reports any account that no longer exists. To merge into an existing file, pass it as the second argument.
3. Commit `signatures.json` to the signatures repository.

## Development

The action has no dependencies; it uses Node's built-in `fetch` and test runner.

```sh
npm test
```
