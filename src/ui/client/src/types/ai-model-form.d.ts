// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
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
