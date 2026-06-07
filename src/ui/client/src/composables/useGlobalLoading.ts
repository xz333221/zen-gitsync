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

interface LoadingState {
  visible: boolean
  text: string
  showProgress: boolean
  progress: number
}

const loadingState = reactive<LoadingState>({
  visible: false,
  text: $t('@F2A3A:加载中...'),
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
    loadingState.text = options?.text || $t('@F2A3A:加载中...')
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

  const setText = (text: string) => {
    if (loadingState.visible) {
      loadingState.text = text
    }
  }

  return {
    loadingState,
    show,
    hide,
    updateProgress,
    updateText,
    setText
  }
}
