import { reactive } from 'vue'

interface SuccessState {
  visible: boolean
  text: string
  description: string
}

const successState = reactive<SuccessState>({
  visible: false,
  text: '操作成功！',
  description: ''
})

export function useSuccessModal() {
  const show = (options?: {
    text?: string
    description?: string
    duration?: number
  }) => {
    successState.visible = true
    successState.text = options?.text || '操作成功！'
    successState.description = options?.description || ''
    
    // 自动隐藏
    const duration = options?.duration || 2000
    setTimeout(() => {
      hide()
    }, duration)
  }

  const hide = () => {
    successState.visible = false
  }

  return {
    successState,
    show,
    hide
  }
}
