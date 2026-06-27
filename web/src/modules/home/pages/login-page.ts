import { createApp, defineComponent, h } from 'vue'

const LoginPage = defineComponent({
  name: 'LoginPage',
  setup() {
    return () => h('section', { class: 'vh-100', style: 'background-color: #e9faff' }, [
      h('div', { class: 'container py-5 h-100' }, [
        h('div', { class: 'row d-flex justify-content-center align-items-center h-100' }, [
          h('div', { class: 'col-12 col-md-8 col-lg-6 col-xl-5' }, [
            h('div', { class: 'card shadow-2-strong', style: 'border-radius: 1rem;' }, [
              h('div', { class: 'card-body p-5 text-center' }, [
                h('h3', { class: 'mb-5' }, '理财人'),
                h('div', { class: 'form-floating mb-3' }, [
                  h('input', { id: 'floatingInput', type: 'email', class: 'form-control', placeholder: 'name@example.com' }),
                  h('label', { for: 'floatingInput' }, 'Email address'),
                ]),
                h('div', { class: 'form-floating mb-4' }, [
                  h('input', { id: 'floatingPassword', type: 'password', class: 'form-control', placeholder: 'Password' }),
                  h('label', { for: 'floatingPassword' }, 'Password'),
                ]),
                h('div', { class: 'd-grid gap-2' }, [
                  h('button', { id: 'login', class: 'btn btn-primary btn-lg', type: 'button' }, '登录或注册'),
                ]),
                h('div', { class: 'py-4' }, [
                  h('a', { href: 'forgot.html', class: 'txt2 hov1' }, '忘记密码?'),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('login-vue-root')
if (root) {
  createApp(LoginPage).mount(root)
}

