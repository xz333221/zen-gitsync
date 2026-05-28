declare module 'ai-model-form/client' {
  import type { DefineComponent } from 'vue'

  export interface AiModelFormSaveData {
    id: number
    endpoint: string
    modelName: string
    displayName: string
    apiKey: string
  }

  const AddModelForm: DefineComponent<
    {
      apiBase?: string
      initial?: {
        endpoint?: string
        modelName?: string
        displayName?: string
        apiKey?: string
      } | null
      theme?: 'dark' | 'light'
    },
    object,
    object
  >
  export { AddModelForm }
}
