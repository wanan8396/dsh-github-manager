# @local/github-manager

> MIT licensed · for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

Full-permission GitHub management inside DSH. Sign in through the browser, then let the agent
create and delete repositories, edit code, manage SSH/GPG/Actions keys and trigger workflows —
all with the OAuth token from that one consent screen. No `gh` CLI, no separate PAT.

## What you get

| Area | Contents |
| --- | --- |
| **Login** | GitHub OAuth web flow (authorization code) against **your own** OAuth App — no credentials ship with the package |
| **Scopes** | `repo` `repo:status` `repo_deployment` `public_repo` `delete_repo` `workflow` `admin:public_key` `admin:repo_hook` `gist` `read:org` `read:user` `user:email` `notifications` |
| **Accounts** | Several GitHub accounts in one encrypted vault, with switch and remove |
| **Settings page** | Settings → **GitHub 管理**: connection state, granted scopes, account list, OAuth App override |
| **Agent tools** | 58 `gh_*` tools covering repos, code, CI, keys, secrets, PRs, releases, collaborators |
| **Secrets** | AES-256-GCM vault at `$DSH_HOME/github-manager`, master key in a separate `0600` file |
| **Skill** | `skills/github-manager/SKILL.md` — how the agent should string the tools together |

## Install

```bash
git clone https://github.com/USERNAME/dsh-github-manager.git
```

Then **Plugins → Add plugin → select that directory**, and enable the `github-manager` row.

If the older `@local/github-oauth` bundle is installed, keep only one of the two enabled: both
register the same OAuth callback path.

## Configure an OAuth App

This package contains **no client id and no client secret**. Register an app once:

1. https://github.com/settings/developers → **New OAuth App**
2. Homepage URL: `http://<your-dsh-host>:3080`
3. **Authorization callback URL**: `http://<your-dsh-host>:3080/plugins/github-oauth/callback`
4. Copy the Client ID, generate a Client Secret

Then give them to the plugin either way:

```bash
# a) environment, read at start-up and never written to disk
export GITHUB_MANAGER_CLIENT_ID=Iv1.xxxxxxxx
export GITHUB_MANAGER_CLIENT_SECRET=xxxxxxxxxxxxxxxx
```

```jsonc
// b) encrypted vault: Settings → GitHub 管理 → 自定义 OAuth App
//    or the agent
{"tool":"gh_auth_setup","args":{"clientId":"Iv1.xxxxxxxx","clientSecret":"xxxxxxxx"}}
```

Both values are stored AES-256-GCM encrypted in `$DSH_HOME/github-manager/vault.json`.

## Sign in

**Settings → GitHub 管理 → 使用 GitHub 登录**, then approve on GitHub. Or through the agent:

```
gh_auth_start          → returns the authorize URL
gh_auth_status         → confirm the connection and see granted scopes
```

State values are 256-bit, single use, and expire after 10 minutes.

## Agent tools

### Account and configuration

| Tool | Purpose |
| --- | --- |
| `gh_auth_status` | Connection state, scopes, vault path |
| `gh_auth_start` | Create a state and return the authorize URL |
| `gh_auth_setup` | Save or read the OAuth App credentials |
| `gh_auth_logout` | Drop every stored token |
| `gh_accounts` / `gh_account_switch` / `gh_account_remove` | Multi-account handling |
| `gh_preferences` | Default repository and pinned repositories |

### Repositories and code

| Tool | Purpose |
| --- | --- |
| `gh_repos` / `gh_repo` | List and inspect repositories |
| `gh_repo_create` | Create under the user or an organization |
| `gh_repo_delete` | Delete permanently; requires `confirm: "DELETE"` |
| `gh_file` | Read a file or list a directory |
| `gh_file_write` / `gh_file_delete` | Commit a change through the contents API |
| `gh_push` | Publish a local directory through the Git Data API; changed files only, credentials blocked |
| `gh_branch_list` / `gh_commit_list` | History |
| `gh_issues` / `gh_issue_create` / `gh_pulls` / `gh_pr_create` | Issues and PRs |
| `gh_search` | Repositories, issues, code, users |

### Keys and secrets

| Tool | Purpose |
| --- | --- |
| `gh_my_key_list` / `gh_my_key_add` / `gh_my_key_remove` | SSH keys on the account |
| `gh_gpg_key_list` / `gh_gpg_key_add` / `gh_gpg_key_remove` | GPG keys on the account |
| `gh_key_list` / `gh_key_add` / `gh_key_remove` | Deploy keys of a repository |
| `gh_secret_list` / `gh_secret_put` / `gh_secret_delete` | Actions secrets, sealed-box encrypted before upload |
| `gh_workflow_list` / `gh_workflow_run` | Actions workflows; trigger one by file name |
| `gh_ci_runs` / `gh_ci_jobs` | Run history, then which job and step broke |
| `gh_ci_logs` | A job's plain-text log, tail-first where failures live |
| `gh_ci_artifacts` | List build artifacts, or download one as a zip |
| `gh_ci_cancel` | Stop a stale run |

### Compile and inspect CI

A full loop through the API alone — push code, trigger the build, read the result, fetch the artifact:

```jsonc
{"repo":"owner/name","dir":"/path/to/project","message":"feat: x"}            // gh_push
{"repo":"owner/name","workflow":"build.yml","ref":"main"}                     // gh_workflow_run
{"repo":"owner/name"}                                                          // gh_ci_runs  → status/conclusion
{"repo":"owner/name"}                                                          // gh_ci_jobs  → step that failed
{"repo":"owner/name","jobId":123,"tailLines":200}                              // gh_ci_logs
{"action":"download","repo":"owner/name","artifactId":456,"dir":"/tmp/out"}    // gh_ci_artifacts
```

`gh_ci_runs` reports status, conclusion, branch, event and duration; `gh_ci_jobs` marks each step
✓ or ✗ so a red build points at one line; `gh_ci_logs` follows GitHub's 302 to the log blob and
returns the tail.

### Push without git

`gh_push` publishes a local directory through the Git Data API — no `git clone`, no `git push`,
no token setup beyond the OAuth login. On a phone the git TLS handshake often stalls for tens of
seconds and uploads far more than needed; this makes five HTTPS calls instead.

```jsonc
{"repo":"owner/name","dir":"/path/to/project","message":"feat: x","branch":"main"}
{"repo":"owner/name","dir":"/path/to/project","message":"probe","dryRun":true}   // report only
{"repo":"owner/name","dir":"/path/to/project","message":"drop it","deletePaths":["old.txt"]}
```

What it does:

- compares each file's `git blob` sha against the remote tree, so **only changed files upload**
- keeps untouched files (the tree is built on `base_tree`), creates the branch when it is missing
- refuses to move a branch that advanced remotely unless `force: true`
- skips `.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, caches and OS junk
- **blocks credential-looking files**: `.env`, `*.pem`, `*.key`, `id_rsa`, `vault.json`, `master.key`,
  and any file containing a GitHub token (`ghp_`/`github_pat_`), a private key block, an OAuth
  `client_secret` assignment or an AWS key — reported back as `blocked`, never uploaded

The same operation is on the settings page as **推送本地目录到仓库**, with a 预演 button.

### Escape hatch

`gh_api` takes any method and path:

```jsonc
{"method":"POST","path":"/repos/owner/name/issues","body":{"title":"hi"}}
{"method":"GET","path":"/user/repos","query":{"per_page":100}}
```

Every tool returns one envelope:

```jsonc
{ "ok": true, "code": "OK", "text": "human/model summary", "data": { }, "status": 200,
  "rateLimitRemaining": 4999, "rateLimitReset": 1790000000 }
```

Failures come back as `ok: false` with a `code` (`E_NOT_CONNECTED`, `E_GITHUB`, `E_RATE_LIMIT`,
`E_INPUT`, …) instead of throwing, so a rejected call does not abort a multi-tool turn.

## Examples

```
建个私有仓库 demo，加个 README         → gh_repo_create { name, private: true, autoInit: true }
把 config.json 里的端口改成 8080        → gh_file → gh_file_write
给我这台机器加个 SSH key                → gh_my_key_add { title, key }
仓库里加 CI secret                      → gh_secret_put { repo, name, value }
删掉刚建的测试仓库                      → gh_repo_delete { repo, confirm: "DELETE" }
看一下 Actions 跑过哪些                 → gh_workflow_list
```

## Security notes

- Tokens and the client secret live only in the AES-256-GCM vault; the master key is a separate
  `0600` file, so copying `vault.json` alone reveals nothing.
- Tool results never include the access token or the client secret.
- Actions secret values are sealed with the repository public key before leaving the process
  (X25519 + XSalsa20-Poly1305, `crypto_box_seal` layout) and are never echoed back.
- HTTP routes reject cross-origin POSTs; the callback pins its `state` to an `HttpOnly` cookie.
- Revoking access on GitHub invalidates the stored token; `gh_auth_logout` clears it locally.

## Limitations

- The repository contains no client id, client secret, access token, or account name. Only the
  OAuth App *you* register, entered locally, is ever used.
- Deleting a repository needs the `delete_repo` scope; accounts that authorized before this scope
  existed must sign in again.
- `gh_secret_put` requires the repository to have Actions enabled so a public key exists.
- No GraphQL: only REST endpoints.

## License

[MIT](LICENSE)
