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
declare module 'local-file-picker/client' {
  import type { DefineComponent } from 'vue'
  const FilePickerModal: DefineComponent<
    {
      visible?: boolean;
      mode?: 'file' | 'directory';
      multiple?: boolean;
      theme?: 'dark' | 'light';
      apiBase?: string;
      locale?: 'zh-CN' | 'en-US';
      /**
       * 初始目录路径。打开 picker 时定位到这个目录(若无效则回落用户目录)。
       * 实际 JS 支持但本地 .d.ts 未声明,这里补齐类型。
       */
      defaultPath?: string;
      messages?: Record<string, Record<string, string>> | null;
    },
    object,
    object
  >
  export { FilePickerModal }
}
