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
import logger from '../utils/logger.js'

// 这些请求成功(2xx/3xx)时没有排障价值,打出来只会把控制台刷成流水账:
// - /assets /fonts /favicon:静态资源,首屏一次就是几十个
// - /api/monitor/system:前端每 ~15s 轮询的心跳
// - /api/workbench/project-icon:首屏对每个项目各拉一次图标
// 非 2xx 照常打印(404/500 才是信号),响应时间超 1s 的也照常打印。
const QUIET_PATH_PREFIXES = ['/assets/', '/fonts/', '/favicon'];
const QUIET_PATHS = new Set(['/api/monitor/system', '/api/workbench/project-icon']);

function isQuietSuccess(req, statusCode) {
  if (statusCode >= 400) return false;
  const urlPath = (req.url || '').split('?')[0];
  if (QUIET_PATHS.has(urlPath)) return true;
  return QUIET_PATH_PREFIXES.some(prefix => urlPath.startsWith(prefix));
}

export function createRequestLogger({ chalk }) {
  return (req, res, next) => {
    const startTime = Date.now();
    const requestTime = new Date().toLocaleString('zh-CN', { hour12: false });

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

      if (duration < 1000 && isQuietSuccess(req, statusCode)) return;

      let statusColor = chalk.green;
      if (statusCode >= 400 && statusCode < 500) {
        statusColor = chalk.yellow;
      } else if (statusCode >= 500) {
        statusColor = chalk.red;
      }

      let durationColor = chalk.gray;
      if (duration > 1000) {
        durationColor = chalk.red;
      } else if (duration > 500) {
        durationColor = chalk.yellow;
      } else if (duration > 200) {
        durationColor = chalk.cyan;
      }

      // 慢请求单独点名:混在普通请求流里容易被看漏
      const slowMark = duration >= 1000 ? chalk.red(' ⚠ SLOW') : '';

      logger.info(
        chalk.dim(`[${requestTime}]`),
        chalk.bold(req.method),
        req.url,
        statusColor(`[${statusCode}]`),
        durationColor(`${duration}ms`),
        slowMark
      );
    });

    next();
  };
}
