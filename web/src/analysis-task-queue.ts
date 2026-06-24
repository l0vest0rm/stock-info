type AnalysisTask = {
  url: string
  title: string
  qtype: string
  button: HTMLAnchorElement
  taskId: string
  cacheKey: string
}

type AnalysisTaskQueueContext = {
  server: string
  reportAnalysisCacheVersion: string
}

export class AnalysisTaskQueue {
  private tasks: AnalysisTask[]
  private isProcessing: boolean
  private notifications: Map<string, HTMLElement>
  private modalInstance: any | null
  private server: string
  private reportAnalysisCacheVersion: string

  constructor(context: AnalysisTaskQueueContext) {
    this.tasks = []
    this.isProcessing = false
    this.notifications = new Map()
    this.modalInstance = null
    this.server = context.server
    this.reportAnalysisCacheVersion = context.reportAnalysisCacheVersion
    this.createNotificationContainer()
  }

  private createNotificationContainer() {
    let container = document.getElementById('analysisNotifications')
    if (!container) {
      container = document.createElement('div')
      container.id = 'analysisNotifications'
      container.style.position = 'fixed'
      container.style.top = '20px'
      container.style.right = '20px'
      container.style.zIndex = '1040'
      container.style.display = 'flex'
      container.style.flexDirection = 'column'
      container.style.gap = '10px'
      document.body.appendChild(container)
    }
  }

  private createNotification(id: string, title: string, status: 'pending' | 'processing' | 'completed') {
    const notification = document.createElement('div')
    notification.id = `analysisNotification-${id}`
    notification.className = `alert alert-${status === 'completed' ? 'success' : status === 'processing' ? 'info' : 'warning'}`
    notification.style.minWidth = '300px'
    notification.style.maxWidth = '400px'
    notification.style.animation = 'slideIn 0.3s ease-out'

    let statusText = ''
    switch (status) {
      case 'pending':
        statusText = '等待中...'
        break
      case 'processing':
        statusText = '分析中...'
        break
      case 'completed':
        statusText = '分析完成'
        break
    }

    notification.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <h6 class="mb-1">${title}</h6>
          <p class="mb-0 text-sm">${statusText}</p>
        </div>
        <button type="button" class="btn-close" data-notification-id="${id}" aria-label="Close"></button>
      </div>
      ${status === 'completed' ? '<div class="mt-2"><a href="javascript:void(0)" class="text-sm link-primary" data-notification-id="' + id + '" data-action="view">查看结果</a></div>' : ''}
    `

    const closeBtn = notification.querySelector('.btn-close')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.removeNotification(id)
      })
    }

    const viewLink = notification.querySelector('[data-action="view"]')
    if (viewLink) {
      viewLink.addEventListener('click', () => {
        this.showAnalysisResult(id, title)
      })
    }

    document.getElementById('analysisNotifications')?.appendChild(notification)
    this.notifications.set(id, notification)
  }

  private updateNotification(id: string, status: 'pending' | 'processing' | 'completed', content?: string, cacheKey?: string) {
    const notification = this.notifications.get(id)
    if (!notification) {
      return
    }

    notification.className = `alert alert-${status === 'completed' ? 'success' : status === 'processing' ? 'info' : 'warning'}`

    let statusText = ''
    switch (status) {
      case 'pending':
        statusText = '等待中...'
        break
      case 'processing':
        statusText = '分析中...'
        break
      case 'completed':
        statusText = '分析完成'
        break
    }

    const contentDiv = notification.querySelector('div.d-flex')
    if (contentDiv) {
      contentDiv.innerHTML = `
        <div>
          <h6 class="mb-1">${notification.querySelector('h6')?.textContent}</h6>
          <p class="mb-0 text-sm">${statusText}</p>
        </div>
        <button type="button" class="btn-close" data-notification-id="${id}" aria-label="Close"></button>
      `
    }

    if (status === 'completed') {
      const viewDiv = notification.querySelector('div.mt-2')
      if (!viewDiv) {
        const newViewDiv = document.createElement('div')
        newViewDiv.className = 'mt-2'
        newViewDiv.innerHTML = `<a href="javascript:void(0)" class="text-sm link-primary" data-notification-id="${id}" data-action="view" data-cache-key="${cacheKey || id}">查看结果</a>`
        notification.appendChild(newViewDiv)

        const viewLink = newViewDiv.querySelector('[data-action="view"]')
        if (viewLink) {
          viewLink.addEventListener('click', () => {
            const actualCacheKey = viewLink.getAttribute('data-cache-key') || id
            this.showAnalysisResult(actualCacheKey, notification.querySelector('h6')?.textContent || '')
            this.removeNotification(id)
          })
        }
      }
    }

    if (status === 'completed' && content) {
      const actualCacheKey = cacheKey || `analysisResult-${id}`
      localStorage.setItem(actualCacheKey, content)
    }

    const closeBtn = notification.querySelector('.btn-close')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.removeNotification(id)
      })
    }
  }

  private removeNotification(id: string) {
    const notification = this.notifications.get(id)
    if (!notification) {
      return
    }
    notification.style.animation = 'slideOut 0.3s ease-in'
    setTimeout(() => {
      notification.remove()
      this.notifications.delete(id)
    }, 300)
  }

  public showAnalysisResult(id: string, title: string) {
    let modal = document.getElementById('analysisModal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'analysisModal'
      modal.className = 'modal fade'
      modal.setAttribute('tabindex', '-1')
      modal.innerHTML = `
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="analysisModalTitle"></h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body" id="analysisModalBody" style="max-height: 70vh; overflow-y: auto;">
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
            </div>
          </div>
        </div>
      `
      document.body.appendChild(modal)
    }

    document.getElementById('analysisModalTitle')!.textContent = title

    const body = document.getElementById('analysisModalBody')!
    const content = localStorage.getItem(id) || ''
    const renderedHtml = (window as any).marked.parse(content)
    const htmlWithBootstrap = renderedHtml.replace(/<table>/g, '<table class="table table-bordered table-sm table-hover">')
    body.innerHTML = `<div class="markdown-content" style="font-size: 14px; line-height: 1.6;">${htmlWithBootstrap}</div>`

    if (this.modalInstance) {
      this.modalInstance.hide()
    }

    const bsModal = new (window as any).bootstrap.Modal(modal)
    bsModal.show()
    this.modalInstance = bsModal
  }

  public addTask(url: string, title: string, qtype: string, button: HTMLAnchorElement) {
    const existingTask = this.tasks.find(task => task.url === url)
    if (existingTask) {
      return
    }

    const taskId = `task-${Date.now()}`
    const cacheKey = `analysisResult-${this.reportAnalysisCacheVersion}-${btoa(url)}`
    this.tasks.push({ url, title, qtype, button, taskId, cacheKey })
    this.createNotification(taskId, title, 'pending')
    void this.processTasks()
  }

  private async processTasks() {
    if (this.isProcessing || this.tasks.length === 0) {
      return
    }

    this.isProcessing = true

    while (this.tasks.length > 0) {
      const task = this.tasks.shift()
      if (!task) {
        continue
      }

      const taskId = task.taskId
      this.updateNotification(taskId, 'processing')

      task.button.style.pointerEvents = 'none'
      task.button.style.opacity = '0.6'
      const originalText = task.button.textContent
      task.button.textContent = '分析中...'

      try {
        const response = await fetch(`${this.server}/api/report/analyze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: task.url, title: task.title, qtype: task.qtype }),
        })
        const result = await response.json() as { code?: number, data?: string, msg?: string }
        if (result.code !== 200) {
          throw new Error(result.msg || '分析失败')
        }
        const content = (result.data || '').trim()
        if (!content) {
          throw new Error('分析结果为空')
        }
        this.updateNotification(taskId, 'completed', content, task.cacheKey)
      } catch (error) {
        console.error('分析研报失败:', error)
        const notification = this.notifications.get(taskId)
        if (notification) {
          notification.className = 'alert alert-danger'
          const contentDiv = notification.querySelector('div.d-flex')
          if (contentDiv) {
            contentDiv.innerHTML = `
              <div>
                <h6 class="mb-1">${task.title}</h6>
                <p class="mb-0 text-sm">分析失败: ${error instanceof Error ? error.message : '未知错误'}</p>
              </div>
              <button type="button" class="btn-close" data-notification-id="${taskId}" aria-label="Close"></button>
            `
          }
        }
      } finally {
        task.button.style.pointerEvents = 'auto'
        task.button.style.opacity = '1'
        task.button.textContent = originalText
      }
    }

    this.isProcessing = false
  }
}

export function installAnalysisTaskQueueStyles(): void {
  if (document.getElementById('analysisTaskQueueStyles')) {
    return
  }
  const style = document.createElement('style')
  style.id = 'analysisTaskQueueStyles'
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(100%);
        opacity: 0;
      }
    }
  `
  document.head.appendChild(style)
}
