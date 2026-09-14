import { createApp, defineComponent, h, onMounted, ref } from 'vue'

function returnPath(): string {
  const raw = new URLSearchParams(location.search).get('returnTo') || '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20]/.test(raw)) return '/'
  const target = new URL(raw, location.origin)
  return target.origin === location.origin && target.pathname !== '/login.html' ? target.pathname + target.search + target.hash : '/'
}

createApp(defineComponent({
  setup() {
    const token = location.hash.startsWith('#reset-password/') ? location.hash.slice(16) : ''
    if (token) history.replaceState(null, '', location.pathname + location.search)
    const mode = ref<'login' | 'request' | 'reset'>(token ? 'reset' : 'login')
    const email = ref('')
    const password = ref('')
    const confirming = ref(false)
    const confirmation = ref('')
    const clearConfirmation = () => { confirming.value = false; confirmation.value = '' }
    const busy = ref(false)
    const message = ref('')
    const error = ref(false)
    const title = () => ({ login: '登录', request: '找回密码', reset: '设置新密码' })[mode.value]
    const switchMode = (next: typeof mode.value) => { mode.value = next; message.value = ''; password.value = ''; clearConfirmation() }
    onMounted(async () => {
      document.title = '登录 - 投研社'
      if (mode.value !== 'login') return
      try {
        const response = await fetch('/api/auth/me')
        if (response.ok && (await response.json()).user) location.replace(returnPath())
      } catch { /* The form remains available after a transient network failure. */ }
    })
    const submit = async (event: Event) => {
      event.preventDefault()
      if (busy.value) return
      if (mode.value === 'login' && confirming.value && confirmation.value !== password.value) { error.value = true; message.value = '两次输入的密码不一致'; return }
      busy.value = true; message.value = ''; error.value = false
      const action = mode.value
      try {
        const endpoint = action === 'request' ? 'password-reset/request' : action === 'reset' ? 'password-reset/confirm' : action
        const response = await fetch(`/api/auth/${endpoint}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'reset' ? { token, password: password.value } : { email: email.value, password: password.value, ...(action === 'login' && confirming.value ? { password_confirmation: confirmation.value } : {}) }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后再试')
        if (action === 'login' && result.requires_password_confirmation) { confirming.value = true; message.value = '首次登录，请再输入一遍密码。两次一致后自动创建账号并登录。'; return }
        if (action === 'request') message.value = '如果该邮箱已注册，重置链接将发送到邮箱，10 分钟内有效。'
        else if (action === 'reset') { switchMode('login'); message.value = '密码已更新，请使用新密码登录。' }
        else location.assign(returnPath())
      } catch (cause) { error.value = true; message.value = cause instanceof Error ? cause.message : '网络错误，请稍后重试' }
      finally { busy.value = false }
    }
    return () => h('main', { class: 'container py-5' }, [
      h('section', { class: 'card border-0 shadow-sm mx-auto p-4', style: 'max-width: 420px' }, [
        h('h1', { class: 'h4 mb-2' }, title()),
        h('p', { class: 'text-muted small mb-4' }, '浏览网站无需登录，打开研报链接时请先登录。'),
        h('form', { onSubmit: submit }, [
          mode.value !== 'reset' ? h('div', { class: 'mb-3' }, [
            h('label', { for: 'auth-email', class: 'form-label' }, '邮箱'),
            h('input', { id: 'auth-email', type: 'email', autocomplete: 'email', required: true, maxlength: 254, class: 'form-control', value: email.value, onInput: (e: Event) => { email.value = (e.target as HTMLInputElement).value; clearConfirmation(); message.value = '' } }),
          ]) : null,
          mode.value !== 'request' ? h('div', { class: 'mb-3' }, [
            h('label', { for: 'auth-password', class: 'form-label' }, mode.value === 'reset' ? '新密码' : '密码'),
            h('input', { id: 'auth-password', type: 'password', autocomplete: mode.value === 'login' && !confirming.value ? 'current-password' : 'new-password', required: true, minlength: 6, maxlength: 1024, placeholder: '至少 6 位', class: 'form-control', value: password.value, onInput: (e: Event) => { password.value = (e.target as HTMLInputElement).value; clearConfirmation(); message.value = '' } }),
          ]) : null,
          mode.value === 'login' && confirming.value ? h('div', { class: 'mb-3' }, [
            h('label', { for: 'auth-confirmation', class: 'form-label' }, '再次输入密码'),
            h('input', { id: 'auth-confirmation', type: 'password', autocomplete: 'new-password', required: true, minlength: 6, maxlength: 1024, class: 'form-control', value: confirmation.value, onInput: (e: Event) => { confirmation.value = (e.target as HTMLInputElement).value } }),
          ]) : null,
          message.value ? h('p', { role: error.value ? 'alert' : 'status', class: error.value ? 'text-danger small' : 'text-success small' }, message.value) : null,
          h('button', { type: 'submit', class: 'btn btn-primary w-100', disabled: busy.value }, busy.value ? '处理中…' : mode.value === 'request' ? '发送重置链接' : title()),
        ]),
        h('div', { class: 'd-flex justify-content-between mt-3' }, [
          mode.value !== 'login' ? h('button', { type: 'button', class: 'btn btn-link p-0 small', disabled: busy.value, onClick: () => switchMode('login') }, '返回登录') : null,
          mode.value === 'login' ? h('button', { type: 'button', class: 'btn btn-link p-0 small', disabled: busy.value, onClick: () => switchMode('request') }, '忘记密码？') : null,
        ]),
      ]),
    ])
  },
})).mount('#login-root')
