import { reactive } from 'vue'

interface LoadingState {
  visible: boolean
  text: string
  showProgress: boolean
  progress: number
}

const loadingState = reactive<LoadingState>({
  visible: false,
  text: '加载中...',
  showProgress: false,
  progress: 0
})

export function useGlobalLoading() {
  const show = (options?: {
    text?: string
    showProgress?: boolean
    progress?: number
  }) => {
    loadingState.visible = true
    loadingState.text = options?.text || '加载中...'
    loadingState.showProgress = options?.showProgress || false
    loadingState.progress = options?.progress || 0
  }

  const hide = () => {
    loadingState.visible = false
  }

  const updateProgress = (progress: number) => {
    loadingState.progress = Math.max(0, Math.min(100, progress))
  }

  const updateText = (text: string) => {
    loadingState.text = text
  }

  return {
    loadingState,
    show,
    hide,
    updateProgress,
    updateText
  }
}
