window.__ModuleLoader__.load({
  id: '@local/github-manager',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const API = '/plugins/github-manager'
    const NS = 'githubManager'
    const SECTION_ID = 'github-manager'
    const STYLE_ID = 'dsh-ghm-style'
    const FULL_SCOPE = 'repo repo:status repo_deployment public_repo delete_repo workflow admin:public_key admin:repo_hook gist read:org read:user user:email notifications'

    const zh = {
      'title': 'GitHub 管理',
      'subtitle': 'OAuth 授权 · 全权限账号与密钥管理',
      'status.title': '连接状态',
      'status.app': 'OAuth App',
      'status.connected': '已连接',
      'status.notConnected': '未连接',
      'status.scope': '授权范围（完整权限）',
      'status.vault': '加密凭据库',
      'status.configured': '已配置',
      'status.notConfigured': '未配置',
      'login.button': '使用 GitHub 登录',
      'login.waiting': '等待授权…',
      'login.hint': '点开链接在浏览器里同意授权；回调后自动连上。state 10 分钟内一次有效。',
      'login.open': '打开授权页面',
      'login.cancel': '取消等待',
      'logout': '登出全部账号',
      'accounts.title': '已连接账号',
      'accounts.empty': '还没有账号，点上面的「使用 GitHub 登录」',
      'accounts.active': '当前使用',
      'accounts.switch': '切换',
      'accounts.remove': '移除',
      'accounts.scopes': '权限',
      'app.title': 'OAuth App（可选）',
      'app.default': '本插件不内置任何凭据：在 GitHub 建一个 OAuth App，把 Client ID / Secret 填在下面（或设 GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET）。',
      'app.custom': '自定义 OAuth App',
      'app.clientId': 'Client ID',
      'app.clientSecret': 'Client Secret',
      'app.useEnv': '读取环境变量',
      'app.save': '保存',
      'app.saved': '已保存',
      'app.callback': '回调地址',
      'tools.title': '给 Agent 用的接口',
      'tools.hint': '授权后可直接让 AI 建仓库、删仓库、改代码、建/删密钥（SSH、GPG、Actions Secret、Deploy Key），全部走 OAuth token，不需要 gh CLI 或额外的 PAT。',
      'tools.list': 'gh_api · gh_repo_create · gh_repo_delete · gh_file_write · gh_file_delete · gh_key_add · gh_secret_put · gh_workflow_run …',
      'common.refresh': '刷新',
      'common.loading': '读取中…',
      'common.error': '出错了',
      'common.confirmRemove': '确认移除账号',
      'push.title': '推送本地目录到仓库',
      'push.hint': '用 GitHub API 直接提交，不用 git clone / git push：只上传有变化的文件，自动跳过 .git、node_modules 和疑似凭据文件（.env、私钥、token）。',
      'push.dir': '本地目录（绝对路径）',
      'push.repo': '仓库 owner/name',
      'push.message': '提交信息',
      'push.branch': '分支（默认 main）',
      'push.dryRun': '预演',
      'push.run': '推送',
      'push.running': '推送中…',
      'push.done': '推送完成',
    }

    const en = {
      'title': 'GitHub manager',
      'subtitle': 'OAuth login · full-permission account and key management',
      'status.title': 'Connection',
      'status.app': 'OAuth App',
      'status.connected': 'Connected',
      'status.notConnected': 'Not connected',
      'status.scope': 'Granted scopes (full permissions)',
      'status.vault': 'Encrypted vault',
      'status.configured': 'configured',
      'status.notConfigured': 'not configured',
      'login.button': 'Sign in with GitHub',
      'login.waiting': 'Waiting for authorization…',
      'login.hint': 'Open the link and approve in the browser; it connects after the callback. The state is single-use for 10 minutes.',
      'login.open': 'Open authorization page',
      'login.cancel': 'Cancel waiting',
      'logout': 'Sign out all accounts',
      'accounts.title': 'Connected accounts',
      'accounts.empty': 'No accounts yet. Use "Sign in with GitHub" above.',
      'accounts.active': 'Active',
      'accounts.switch': 'Switch',
      'accounts.remove': 'Remove',
      'accounts.scopes': 'Scopes',
      'app.title': 'OAuth App (optional)',
      'app.default': 'No credentials ship with this plugin: create an OAuth App on GitHub and paste its Client ID / Secret below (or set GITHUB_MANAGER_CLIENT_ID / GITHUB_MANAGER_CLIENT_SECRET).',
      'app.custom': 'Custom OAuth App',
      'app.clientId': 'Client ID',
      'app.clientSecret': 'Client Secret',
      'app.useEnv': 'Read from environment',
      'app.save': 'Save',
      'app.saved': 'Saved',
      'app.callback': 'Callback URL',
      'tools.title': 'Interfaces for the agent',
      'tools.hint': 'After login, let the AI create/delete repos, edit code, and create/delete keys (SSH, GPG, Actions secrets, deploy keys) — all via the OAuth token, no gh CLI or separate PAT.',
      'tools.list': 'gh_api · gh_repo_create · gh_repo_delete · gh_file_write · gh_file_delete · gh_key_add · gh_secret_put · gh_workflow_run …',
      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.error': 'Error',
      'common.confirmRemove': 'Confirm account removal',
      'push.title': 'Push a local directory',
      'push.hint': 'Commits through the GitHub API — no git clone or git push. Only changed files upload; .git, node_modules and anything looking like a credential (.env, private keys, tokens) is skipped.',
      'push.dir': 'Local directory (absolute path)',
      'push.repo': 'Repository owner/name',
      'push.message': 'Commit message',
      'push.branch': 'Branch (default main)',
      'push.dryRun': 'Dry run',
      'push.run': 'Push',
      'push.running': 'Pushing…',
      'push.done': 'Pushed',
    }

    const state = { status: null, error: '', busy: '', authUrl: '', clientId: '', clientSecret: '', appSaved: false, pushDir: '', pushRepo: '', pushMessage: '', pushBranch: 'main', pushResult: '' }

    /** The registered callback of the built-in OAuth App. */
    function callbackUrl() {
      const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
      return `${origin}/plugins/github-oauth/callback`
    }
    const listeners = new Set()
    const emit = () => { for (const fn of Array.from(listeners)) fn() }
    const patch = (next) => { Object.assign(state, next); emit() }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => { listeners.add(force); return () => listeners.delete(force) }, [])
      return state
    }

    async function api(route, body) {
      const res = await fetch(API + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const text = await res.text()
      let json = null
      try { json = text === '' ? null : JSON.parse(text) } catch {}
      if (!res.ok || (json && json.ok === false)) throw new Error((json && json.error) || `HTTP ${res.status}`)
      return json || {}
    }

    function Icon(props) {
      const size = (props && props.size) || 18
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z' })
      )
    }

    function Card(props) {
      return h('section', { className: 'ghm-card' },
        h('div', { className: 'ghm-card-head' },
          h('h2', { className: 'ghm-card-title' }, props.title),
          props.aside || null
        ),
        props.children
      )
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        className: 'ghm-btn' + (props.primary ? ' ghm-primary' : '') + (props.danger ? ' ghm-danger' : ''),
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children)
    }

    async function refresh(t) {
      patch({ busy: 'refresh' })
      try {
        const status = await api('/status')
        patch({ status, busy: '' })
      } catch (error) {
        patch({ busy: '', error: error.message })
      }
    }

    async function startLogin(t) {
      patch({ busy: 'login', error: '', authUrl: '' })
      try {
        const reply = await api('/start', {})
        patch({ authUrl: reply.authorizeUrl, busy: '' })
        window.open(reply.authorizeUrl, '_blank', 'noopener')
      } catch (error) {
        patch({ busy: '', error: error.message })
      }
    }

    async function logout(t) {
      patch({ busy: 'logout' })
      try {
        await api('/logout', {})
        patch({ busy: '', authUrl: '' })
        await refresh(t)
      } catch (error) { patch({ busy: '', error: error.message }) }
    }

    async function switchAccount(t, login) {
      patch({ busy: `switch:${login}` })
      try {
        await api('/accounts/switch', { login })
        patch({ busy: '' })
        await refresh(t)
      } catch (error) { patch({ busy: '', error: error.message }) }
    }

    async function removeAccount(t, login) {
      if (!window.confirm(`${t('common.confirmRemove')}: ${login}?`)) return
      patch({ busy: `remove:${login}` })
      try {
        await api('/accounts/remove', { login })
        patch({ busy: '' })
        await refresh(t)
      } catch (error) { patch({ busy: '', error: error.message }) }
    }

    async function saveApp(t, useEnv) {
      patch({ busy: 'app' })
      try {
        const body = useEnv ? { useEnv: true } : { clientId: state.clientId, clientSecret: state.clientSecret }
        await api('/config', body)
        patch({ busy: '', appSaved: true })
        await refresh(t)
      } catch (error) { patch({ busy: '', error: error.message }) }
    }

    async function runPush(t, dryRun) {
      patch({ busy: dryRun ? 'push-dry' : 'push', pushResult: '', error: '' })
      try {
        const reply = await api('/push', {
          dir: state.pushDir,
          repo: state.pushRepo,
          message: state.pushMessage,
          branch: state.pushBranch || 'main',
          dryRun,
        })
        patch({ busy: '', pushResult: reply.text || JSON.stringify(reply) })
      } catch (error) {
        patch({ busy: '', error: error.message })
      }
    }

    function Page(props) {
      const t = props.t
      const s = useStore()
      React.useEffect(() => { void refresh(t) }, [])

      const body = []
      if (s.error !== '') body.push(h('div', { className: 'ghm-error', key: 'err', role: 'alert' }, s.error))

      // Login / status card
      const status = s.status
      const connected = status !== null && status.connected
      body.push(h(Card, {
        key: 'status',
        title: t('status.title'),
        aside: h(Btn, { onClick: () => void refresh(t) }, s.busy === 'refresh' ? t('common.loading') : t('common.refresh')),
      },
        status === null
          ? h('p', { className: 'ghm-hint' }, t('common.loading'))
          : h('div', null,
            h('div', { className: 'ghm-row' },
              h('span', { className: 'ghm-chip' + (connected ? ' ghm-on' : '') }, connected ? '● ' + t('status.connected') + ': ' + status.activeLogin : '○ ' + t('status.notConnected')),
              h('span', { className: 'ghm-chip' }, t('status.app') + ': ' + (status.configured ? `${t('status.configured')} (${status.oauthAppMode})` : t('status.notConfigured'))),
            ),
            h('div', { className: 'ghm-scope' },
              h('span', { className: 'ghm-sub' }, t('status.scope')),
              h('code', null, FULL_SCOPE)
            ),
            h('p', { className: 'ghm-hint' }, `${t('status.vault')}: ${status.vault ? status.vault.path : '-'}`),
            connected
              ? h('div', { className: 'ghm-row' },
                h(Btn, { primary: true, disabled: s.busy === 'login', onClick: () => void startLogin(t) }, t('login.button')),
                h(Btn, { danger: true, disabled: s.busy === 'logout', onClick: () => void logout(t) }, t('logout'))
              )
              : h(Btn, { primary: true, disabled: s.busy === 'login', onClick: () => void startLogin(t) }, s.busy === 'login' ? t('login.waiting') : t('login.button')),
            s.authUrl !== ''
              ? h('div', { className: 'ghm-authbox' },
                h('p', { className: 'ghm-hint' }, t('login.hint')),
                h('a', { href: s.authUrl, target: '_blank', rel: 'noopener' }, t('login.open')),
                h('div', null, h(Btn, { onClick: () => patch({ authUrl: '' }) }, t('login.cancel')))
              )
              : null
          )
      ))

      // Accounts card
      const accounts = status === null ? [] : (status.accounts || [])
      body.push(h(Card, { key: 'accounts', title: `${t('accounts.title')} (${accounts.length})` },
        accounts.length === 0
          ? h('p', { className: 'ghm-hint' }, t('accounts.empty'))
          : h('div', { className: 'ghm-list' }, accounts.map((a) =>
            h('div', { className: 'ghm-item' + (a.login === (status && status.activeLogin) ? ' ghm-active' : ''), key: a.login },
              h('div', { className: 'ghm-who' },
                h('strong', null, a.login),
                a.name ? h('span', { className: 'ghm-sub' }, a.name) : null,
                h('span', { className: 'ghm-sub' }, `${t('accounts.scopes')}: ${a.scopes.join(', ') || '-'}`)
              ),
              a.login === (status && status.activeLogin)
                ? h('span', { className: 'ghm-badge' }, t('accounts.active'))
                : h(Btn, { disabled: s.busy === `switch:${a.login}`, onClick: () => void switchAccount(t, a.login) }, t('accounts.switch')),
              h(Btn, { danger: true, disabled: s.busy === `remove:${a.login}`, onClick: () => void removeAccount(t, a.login) }, t('accounts.remove'))
            )
          ))
      ))

      // OAuth App config
      body.push(h(Card, { key: 'app', title: t('app.title') },
        h('p', { className: 'ghm-hint' }, t('app.default')),
        h('p', { className: 'ghm-hint' }, `${t('app.callback')}: ${callbackUrl()}`),
        h('div', { className: 'ghm-row' },
          h('input', { className: 'ghm-input', placeholder: t('app.clientId'), value: s.clientId, onChange: (e) => patch({ clientId: e.currentTarget.value, appSaved: false }) }),
          h('input', { className: 'ghm-input', placeholder: t('app.clientSecret'), type: 'password', value: s.clientSecret, onChange: (e) => patch({ clientSecret: e.currentTarget.value, appSaved: false }) })
        ),
        h('div', { className: 'ghm-row' },
          h(Btn, { disabled: s.busy === 'app' || s.clientId === '', onClick: () => void saveApp(t, false) }, t('app.save')),
          h(Btn, { disabled: s.busy === 'app', onClick: () => void saveApp(t, true) }, t('app.useEnv')),
          s.appSaved ? h('span', { className: 'ghm-ok' }, t('app.saved')) : null
        )
      ))

      // Push card
      body.push(h(Card, { key: 'push', title: t('push.title') },
        h('p', { className: 'ghm-hint' }, t('push.hint')),
        h('div', { className: 'ghm-row' },
          h('input', { className: 'ghm-input', placeholder: t('push.dir'), value: s.pushDir, spellCheck: false, onChange: (e) => patch({ pushDir: e.currentTarget.value }) }),
        ),
        h('div', { className: 'ghm-row' },
          h('input', { className: 'ghm-input', placeholder: t('push.repo'), value: s.pushRepo, spellCheck: false, onChange: (e) => patch({ pushRepo: e.currentTarget.value }) }),
          h('input', { className: 'ghm-input ghm-narrow', placeholder: t('push.branch'), value: s.pushBranch, spellCheck: false, onChange: (e) => patch({ pushBranch: e.currentTarget.value }) }),
        ),
        h('div', { className: 'ghm-row' },
          h('input', { className: 'ghm-input', placeholder: t('push.message'), value: s.pushMessage, onChange: (e) => patch({ pushMessage: e.currentTarget.value }) }),
        ),
        h('div', { className: 'ghm-row' },
          h(Btn, { disabled: s.pushDir === '' || s.pushRepo === '', onClick: () => void runPush(t, true) }, s.busy === 'push-dry' ? '…' : t('push.dryRun')),
          h(Btn, { primary: true, disabled: s.busy === 'push' || s.pushDir === '' || s.pushRepo === '' || s.pushMessage === '', onClick: () => void runPush(t, false) }, s.busy === 'push' ? t('push.running') : t('push.run'))
        ),
        s.pushResult !== ''
          ? h('pre', { className: 'ghm-result' }, s.pushResult)
          : null
      ))

      // Agent tools hint
      body.push(h(Card, { key: 'tools', title: t('tools.title') },
        h('p', { className: 'ghm-hint' }, t('tools.hint')),
        h('code', { className: 'ghm-code' }, t('tools.list'))
      ))

      return h('div', { className: 'ghm-page' },
        h('header', { className: 'ghm-head' },
          h('span', { className: 'ghm-glyph' }, h(Icon, { size: 20 })),
          h('div', null, h('h1', null, t('title')), h('p', null, t('subtitle')))
        ),
        h('div', { className: 'ghm-body' }, body)
      )
    }

    const CSS = [
      '.ghm-page{box-sizing:border-box;height:100%;overflow:auto;padding:20px 22px 40px;font:inherit;line-height:1.55;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.ghm-page *{box-sizing:border-box}',
      '.ghm-head{display:flex;align-items:center;gap:12px}',
      '.ghm-glyph{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.14));background:var(--dsw-alias-bg-layer-2,rgba(31,35,40,.04))}',
      '.ghm-head h1{margin:0;font-size:1.15em;font-weight:600}',
      '.ghm-head p{margin:2px 0 0;font-size:.85em;color:var(--dsw-alias-label-tertiary,#6e7781)}',
      '.ghm-body{display:flex;flex-direction:column;gap:14px;padding-top:18px}',
      '.ghm-card{border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.12));border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.ghm-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}',
      '.ghm-card-title{margin:0;font-size:.95em;font-weight:600;flex:none}',
      '.ghm-card-head .ghm-btn{margin-left:auto}',
      '.ghm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}',
      '.ghm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.16));background:transparent;color:inherit;border-radius:8px;padding:6px 11px;font:inherit;font-size:.86em;cursor:pointer}',
      '.ghm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.06))}',
      '.ghm-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.ghm-primary{background:var(--dsw-alias-state-business-primary,#247bbf);border-color:transparent;color:#fff;font-weight:600}',
      '.ghm-danger{border-color:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e)}',
      '.ghm-chip{font-size:.8em;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.16));color:var(--dsw-alias-label-secondary,#57606a)}',
      '.ghm-chip.ghm-on{border-color:var(--dsw-alias-state-success-primary,#2da44e);color:var(--dsw-alias-state-success-primary,#2da44e)}',
      '.ghm-hint{margin:6px 0;font-size:.82em;color:var(--dsw-alias-label-tertiary,#6e7781);line-height:1.65}',
      '.ghm-scope{margin:8px 0;font-size:.82em}',
      '.ghm-scope summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#57606a)}',
      '.ghm-scope code,.ghm-code{display:block;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;line-height:1.6;margin-top:6px}',
      '.ghm-code{background:var(--dsw-alias-bg-layer-2,rgba(31,35,40,.04));padding:8px 10px;border-radius:8px}',
      '.ghm-list{display:flex;flex-direction:column;gap:4px}',
      '.ghm-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.1))}',
      '.ghm-item.ghm-active{border-color:var(--dsw-alias-state-business-primary,#247bbf)}',
      '.ghm-who{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.ghm-sub{font-size:.76em;color:var(--dsw-alias-label-tertiary,#6e7781)}',
      '.ghm-badge{font-size:.76em;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#247bbf);color:#fff}',
      '.ghm-input{border:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.16));background:var(--dsw-alias-bg-layer-2,rgba(31,35,40,.03));color:inherit;border-radius:8px;padding:7px 10px;font:inherit;font-size:.86em;flex:1;min-width:140px}',
      '.ghm-ok{font-size:.82em;color:var(--dsw-alias-state-success-primary,#2da44e)}',
      '.ghm-authbox{margin-top:10px;padding:10px 12px;border:1px dashed var(--dsw-alias-state-business-primary,#247bbf);border-radius:10px}',
      '.ghm-authbox a{display:inline-block;margin:6px 0;color:var(--dsw-alias-state-business-primary,#247bbf)}',
      '.ghm-narrow{flex:0 1 140px}',
      '.ghm-result{margin:8px 0 0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(31,35,40,.04));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78em;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}',
      '.ghm-error{border:1px solid var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e);border-radius:10px;padding:9px 12px;font-size:.86em}',
    ].join('\n')

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'github-manager: locale')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return () => {}
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
        return () => el.remove()
      }, 'github-manager: styles')

      ctx.effect(
        () => ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 13, label: () => t('title'), icon: SECTION_ID, locale: NS, inject: () => ({ t }) },
            Page,
          ),
        ),
        'github-manager: settings section',
      )

      ctx.effect(
        () => ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID, order: 13, label: () => t('title') }, Icon),
        ),
        'github-manager: settings icon',
      )
    }

    // The settings section component needs its `t` injected; wrap it.
    function BoundPage(props) {
      return h(Page, { t: (key) => props.t ? props.t(key) : key })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
