# @local/github-manager

> MIT licensed · for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

Full-permission GitHub management inside DSH. Sign in through the browser, then let the agent
create and delete repositories, edit code, manage SSH/GPG/Actions keys and trigger workflows —
all with the OAuth token from that one consent screen. No `gh` CLI, no separate PAT.

## What you get

| Area | Contents |
| --- | --- |
| **Login** | GitHub OAuth web flow (authorization code) with a built-in OAuth App, so it works right after installation |
| **Scopes** | `repo` `repo:status` `repo_deployment` `public_repo` `delete_repo` `workflow` `admin:public_key` `admin:repo_hook` `gist` `read:org` `read:user` `user:email` `notifications` |
| **Accounts** | Several GitHub accounts in one encrypted vault, with switch and remove |
| **Settings page** | Settings → **GitHub 管理**: connection state, granted scopes, account list, OAuth App override |
| **Agent tools** | 37 `gh_*` tools, including `gh_api` for any REST endpoint |
| **Secrets** | AES-256-GCM vault at `$DSH_HOME/github-manager`, master key in a separate `0600` file |

## Install

```bash
git clone https://github.com/wanan8396/dsh-github-manager.git
```

Then **Plugins → Add plugin → select that directory**, and enable the `github-manager` row.

The plugin replaces the older `@local/github-oauth` bundle: both register the same OAuth callback,
so keep only one of them enabled.

## Sign in

Open **Settings → GitHub 管理** and press **使用 GitHub 登录**. Approve on GitHub; the callback
stores the token and the page flips to connected. Or ask the agent:

```
gh_auth_start          → returns the authorize URL
gh_auth_status         → confirm the connection and see granted scopes
```

State values are 256-bit, single use, and expire after 10 minutes.

### Custom OAuth App (optional)

1. https://github.com/settings/developers → **New OAuth App**
2. Authorization callback URL: `http://<your-dsh-host>:3080/plugins/github-oauth/callback`
3. Paste Client ID / Secret into Settings → GitHub 管理, or call
   `gh_auth_setup({ clientId, clientSecret })`.

`gh_auth_setup({ useDefault: true })` switches back to the built-in app.

## Agent tools

### Account and configuration

| Tool | Purpose |
| --- | --- |
| `gh_auth_status` | Connection state, scopes, vault path |
| `gh_auth_start` | Create a state and return the authorize URL |
| `gh_auth_setup` | Built-in or custom OAuth App |
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
| `gh_workflow_list` / `gh_workflow_run` | Actions workflows |

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

- The built-in OAuth App's client secret ships with the bundle. It is only usable from this local
  process, and any token still requires the user's own consent, but it is not a secret in the
  "protects your account" sense — register your own app if that matters.
- Deleting a repository needs the `delete_repo` scope; accounts that authorized before this scope
  existed must sign in again.
- `gh_secret_put` requires the repository to have Actions enabled so a public key exists.
- No GraphQL: only REST endpoints.

## License

[MIT](LICENSE)
