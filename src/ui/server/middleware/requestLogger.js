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
export function createRequestLogger({ chalk }) {
  return (req, res, next) => {
    const startTime = Date.now();
    const requestTime = new Date().toLocaleString('zh-CN', { hour12: false });

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

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

      console.log(
        chalk.dim(`[${requestTime}]`),
        chalk.bold(req.method),
        req.url,
        statusColor(`[${statusCode}]`),
        durationColor(`${duration}ms`)
      );
    });

    next();
  };
}
