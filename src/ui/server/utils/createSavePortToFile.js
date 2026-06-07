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
export function createSavePortToFile({ savePort, fs, path, cwdFn = process.cwd }) {
  let savedPort = null;

  return async function savePortToFile(port) {
    try {
      if (savePort && savedPort !== port) {
        savedPort = port;

        const portFilePath = path.join(cwdFn(), '.port');
        await fs.writeFile(portFilePath, port.toString(), 'utf8');
        console.log(`端口号 ${port} 已保存到 ${portFilePath}`);

        try {
          const clientPath = path.join(cwdFn(), 'src', 'ui', 'client');
          const envPath = path.join(clientPath, '.env.local');

          await fs.access(clientPath).catch(() => {
            console.log(`客户端目录 ${clientPath} 不存在，跳过环境变量设置`);
            return Promise.reject(new Error('Client directory not found'));
          });

          await fs.writeFile(envPath, `VITE_BACKEND_PORT=${port}\n`, 'utf8');
          console.log(`端口号环境变量已保存到 ${envPath}`);
        } catch (envError) {
          console.error('保存端口号到环境变量失败，但不影响主要功能:', envError);
        }
      }
    } catch (error) {
      console.error('保存端口号到文件失败:', error);
    }
  };
}
