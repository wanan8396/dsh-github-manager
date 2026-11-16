---
name: github-manager
description: 通过 @local/github-manager 插件的 58 个 gh_* 工具操作 GitHub：OAuth 登录、建/删/改仓库、读写删代码、SSH 与 GPG 与 Deploy Key、Actions Secret、推送本地目录、查看 CI 运行与日志与产物、PR 与 issue 与评论、release 与 tag、协作者与 webhook。当用户要在 GitHub 上读代码、改仓库、编译看结果、批量推送、管理密钥或做协作操作时使用。Drive GitHub through the gh_* tools registered by the @local/github-manager DSH plugin.
whenToUse: 用户要在 GitHub 上建/删/改仓库、读或改仓库代码、推送本地目录、查看或触发 CI 编译、下载构建产物、管理 SSH/GPG/Deploy Key/Actions Secret、开 PR 或 review、发 release、查 issue 或评论时。用户提到 github、仓库、PR、CI、Actions、release、deploy key、推送代码时也适用。
---

# GitHub 操作指南

本插件把 GitHub 的一切操作做成了 `gh_*` 工具，**全部走 OAuth token**，不需要 `gh` CLI，也不需要额外 PAT。

## 先看状态

任何 GitHub 操作前先确认连接：

```
gh_auth_status        → connected / 已授权 scopes / 账号
gh_accounts           → 多账号列表与当前账号
```

**没连接**（`E_NOT_CONNECTED`）时不要直接调业务工具，先走登录：

1. `gh_auth_start` 返回授权链接，让用户打开并同意
2. 用户确认后 `gh_auth_status` 复查

需要完整权限（尤其 `admin:public_key` 管 SSH 密钥、`delete_repo` 删仓库）时，若 status 显示的 scopes 不全，提示用户重新走一遍 `gh_auth_start` 授权。

## 工具分组

### 账号
| 工具 | 用途 |
| --- | --- |
| `gh_auth_status` / `gh_auth_start` / `gh_auth_setup` / `gh_auth_logout` | 登录流程与应用配置 |
| `gh_accounts` / `gh_account_switch` / `gh_account_remove` | 多账号 |
| `gh_preferences` | 默认仓库、固定仓库 |

### 仓库
| 工具 | 用途 |
| --- | --- |
| `gh_repos` / `gh_repo` | 列表、详情 |
| `gh_repo_create` | 建仓，可指定 org、private、autoInit |
| `gh_repo_update` | 改描述、可见性、默认分支、topics、归档 |
| `gh_repo_delete` | **删仓，必须 `confirm: "DELETE"`** |

### 代码
| 工具 | 用途 |
| --- | --- |
| `gh_file` | 读文件或列目录 |
| `gh_file_write` / `gh_file_delete` | 单文件写/删（走 contents API，需 sha 才能更新/删除） |
| `gh_push` | **批量推送本地目录**（推荐，见下） |
| `gh_download` | 下载仓库快照或单文件到本地 |
| `gh_branch_list` / `gh_branch_create` / `gh_branch_delete` | 分支（默认分支不能删） |
| `gh_commit_list` / `gh_compare` / `gh_tag_list` | 历史与差异 |

### 编译与 CI
| 工具 | 用途 |
| --- | --- |
| `gh_workflow_list` / `gh_workflow_run` | 列工作流、触发 workflow_dispatch |
| `gh_ci_runs` | 运行历史：状态、结论、分支、耗时 |
| `gh_ci_jobs` | 某次运行的 job 与**每步 ✓/✗** |
| `gh_ci_logs` | job 日志尾部（失败原因通常在这里） |
| `gh_ci_artifacts` | 列出或下载构建产物 zip |
| `gh_ci_cancel` | 取消运行 |

### 密钥与 Secret
| 工具 | 用途 |
| --- | --- |
| `gh_my_key_*` | 账号级 SSH key（`admin:public_key`） |
| `gh_gpg_key_*` | 账号级 GPG key |
| `gh_key_*` | 仓库 Deploy Key |
| `gh_secret_*` | Actions Secret（上传前自动 sealed-box 加密，值不会回显） |

### 协作
| 工具 | 用途 |
| --- | --- |
| `gh_issues` / `gh_issue_create` / `gh_comment` | issue 与评论（PR 共用评论线程） |
| `gh_pulls` / `gh_pr_create` / `gh_pr_detail` / `gh_pr_merge` | PR 全流程 |
| `gh_collaborators` | 协作者增删查 |
| `gh_hooks` | webhook |
| `gh_release_create` / `gh_release_list` | 发版 |
| `gh_gist` / `gh_orgs` / `gh_search` | 其他 |
| `gh_api` | **兜底**：任意 REST 端点 |

## 关键用法

### 推送本地代码

优先用 `gh_push`，不要建议 `git push`：手机上 git TLS 握手经常卡住，而且会重复上传远端已有的对象。

```jsonc
{"repo":"owner/name","dir":"/绝对路径","message":"feat: x","branch":"main"}
{"repo":"owner/name","dir":"/绝对路径","message":"预演","dryRun":true}
{"repo":"owner/name","dir":"/绝对路径","message":"删文件","deletePaths":["old.txt"]}
```

- 只上传内容有变化的文件；未变文件不会被删（基于 `base_tree`）
- 分支不存在会自动创建
- 远端有新提交时拒绝覆盖，除非 `force: true`
- 自动跳过 `.git`、`node_modules`、`.venv`、`dist`、`build`
- **自动拦截凭据文件**（`.env`、`*.pem`、`*.key`、`id_rsa`、`vault.json`、含 `ghp_` token 等）并在结果里列出 `blocked`

### 改代码的标准流程

```
1. gh_download  {repo, dir:"/tmp/proj"}        # 拉到本地
2. 本地编辑（用 write / edit 工具）
3. gh_push      {repo, dir:"/tmp/proj", message:"..."}   # 推回去
```

单文件小改可以直接 `gh_file` 读 → `gh_file_write` 写，省掉下载。

### 编译并看结果

```
1. gh_workflow_run  {repo, workflow:"build.yml"}     # 或先 push 带 workflow 的代码
2. gh_ci_runs       {repo}                            # 等状态变 completed
3. gh_ci_runs       {repo, conclusion:"failure"}      # 失败时
4. gh_ci_jobs       {repo, runId}                     # 找 ✗ 的那一步
5. gh_ci_logs       {repo, jobId, tailLines:200}      # 看日志尾部
6. gh_ci_artifacts  {action:"download", repo, artifactId, dir:"/tmp/out"}
```

CI 是异步的：触发后立刻查通常还是 `queued`/`in_progress`，需要等待（简单构建约 10-60 秒），可以隔一段时间再查 `gh_ci_runs`。

### 兜底

任何没封装的操作都用 `gh_api`：

```jsonc
{"method":"GET","path":"/repos/{o}/{r}/stats/contributors"}
{"method":"POST","path":"/repos/{o}/{r}/labels","body":{"name":"bug","color":"ff0000"}}
```

## 规则

1. **破坏性操作先确认**：`gh_repo_delete`、`gh_branch_delete`、`gh_secret_delete`、`gh_key_remove`、`gh_collaborators {action:"remove"}`、`gh_account_remove` 在用户明确要求前不要执行。`gh_repo_delete` 必须 `confirm:"DELETE"`。
2. **不要输出 token**：`gh_auth_status` / `gh_accounts` 本来就不返回 token 和 client secret，也不要尝试用 `gh_api` 去读凭据类端点。
3. **凭据不进仓库**：把带密钥的文件推上去之前，`gh_push` 会拦截；不要用 `gh_file_write` 绕过这个保护去写 `.env`、私钥或 token。
4. **`repo` 参数**：多数工具接受省略，会用 `gh_preferences` 里设的默认仓库；不确定当前默认仓库时先读一次，或在调用时显式传 `owner/name`。
5. **失败信封**：每个工具返回 `{ok, code, text, data, status}`。`ok:false` 时读 `code`：`E_NOT_CONNECTED`（先登录）、`E_RATE_LIMIT`（等 `rateLimitReset`）、`E_GITHUB`（真实 API 报错，读 `text`）、`E_INPUT`（参数问题）。**不要盲目重试** `E_GITHUB`，先看错误信息。
6. **缓存**：写操作后插件会自动清理 GET 缓存，所以「创建后立刻列表」能看到新数据；不需要额外等待。
7. **一次一个目标**：不要在没确认前批量删仓库或批量改可见性；涉及多个仓库时逐个报告结果。

## 常见需求对照

| 用户说 | 用哪些工具 |
| --- | --- |
| 看看这个仓库的代码 | `gh_repo` → `gh_file`（目录）→ `gh_file`（文件） |
| 帮我建一个仓库 | `gh_repo_create` |
| 把这个项目传上去 | `gh_push` |
| 改一下 README | `gh_download` → 编辑 → `gh_push`；或 `gh_file` → `gh_file_write` |
| 跑一下编译 | `gh_workflow_run` → `gh_ci_runs` → `gh_ci_jobs` / `gh_ci_logs` |
| 编译为什么挂了 | `gh_ci_runs` → `gh_ci_jobs`（找 ✗）→ `gh_ci_logs` |
| 把构建产物下下来 | `gh_ci_artifacts {action:"download"}` |
| 加个 SSH key | `gh_my_key_add` |
| 加个 CI 密钥 | `gh_secret_put` |
| 开个 PR | `gh_branch_create` → `gh_file_write` → `gh_pr_create` → `gh_pr_merge` |
| 发个版本 | `gh_release_create` |
| 看 issue | `gh_issues` → `gh_comment`（不传 body 即列出评论） |
