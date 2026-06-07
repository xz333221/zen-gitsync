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
import { $t } from '@/lang/static'
import { reactive } from 'vue'

interface SuccessState {
  visible: boolean
  text: string
  description: string
}

const successState = reactive<SuccessState>({
  visible: false,
  text: $t('@B8591:操作成功！'),
  description: ''
})

export function useSuccessModal() {
  const show = (options?: {
    text?: string
    description?: string
    duration?: number
  }) => {
    successState.visible = true
    successState.text = options?.text || $t('@B8591:操作成功！')
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
