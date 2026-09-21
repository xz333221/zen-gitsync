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
// g ai 的「扩展」聚合层 —— 把 Skill 与 MCP 两类外部能力收敛成一个对象,
// 交给 agent 循环统一消费。存在的意义是**把生命周期收在一处**:
//   - 加载顺序固定(skill 是纯文本,立刻可用;MCP 要起子进程,可能慢/可能失败)
//   - 失败一律降级,绝不让扩展问题变成 "g ai 起不来"
//   - /cwd 切换工作目录时要能重新解析项目级扩展,同时关掉旧目录起的子进程
//
// 与 tools.js 的关系:内置 7 个工具是**底座**,永远存在。
// 这里的 MCP 工具是**叠加**,名字以 mcp__ 开头,由 agent 循环按名字分流;
// 名字不认识时返回 null,让调用方回落内置工具 —— 所以扩展全挂也不影响原有能力。

import { loadSkills, buildSkillsPrompt } from './skills.js';
import { McpManager, loadMcpServers } from './mcp.js';

export class AgentExtensions {
  constructor({ skills = [], errors = [], mcp = null, cwd = '' } = {}) {
    this.skills = skills;
    this.errors = errors;
    this.mcp = mcp;
    this.cwd = cwd;
  }

  /**
   * 加载当前目录下的全部扩展。
   *
   * @param {{ cwd?: string, locale?: string, onWarn?: (message: string) => void,
   *           onNotice?: (message: string) => void }} [options]
   * @returns {Promise<AgentExtensions>}
   */
  static async load({ cwd, locale, onWarn, onNotice } = {}) {
    const { skills, errors } = await loadSkills({ cwd }).catch(err => ({
      skills: [],
      errors: [{ root: String(cwd || ''), message: err.message }],
    }));
    if (errors.length && onWarn) {
      for (const error of errors) onWarn(`Skill 目录读取失败(${error.root}): ${error.message}`);
    }

    let mcp = null;
    try {
      const { servers, sources } = await loadMcpServers({ cwd });
      const enabledCount = Object.values(servers).filter(cfg => !cfg.disabled).length;
      // MCP 建连是启动路径上的同步阻塞点(npx 首次还要下载包,实测可到 20s+),
      // 有事可做时先说一声,免得用户以为 g ai 卡死了。
      if (enabledCount > 0) onNotice?.(enabledCount);
      mcp = await McpManager.create({ cwd, servers, sources, onWarn });
    } catch (err) {
      onWarn?.(`MCP 初始化失败(已跳过): ${err.message}`);
    }

    // 没有任何 MCP 工具且没有连接失败信息时,把空管理器丢掉,少一层判断
    if (mcp && mcp.connections.length === 0) mcp = null;
    return new AgentExtensions({ skills, errors, mcp, cwd });
  }

  /** 追加到系统提示词末尾的内容(无扩展时是空串) */
  promptSuffix(locale) {
    const skillBlock = buildSkillsPrompt(this.skills, { locale });
    const mcpBlock = this.mcp ? this.mcp.describe({ locale }) : '';
    return `${skillBlock}${mcpBlock}`;
  }

  /** 叠加到内置工具表之后的 OpenAI function calling 定义 */
  get tools() {
    return this.mcp ? this.mcp.toolDefinitions : [];
  }

  /** 是否是本层接管的名字。agent 循环据此决定走扩展还是内置工具。 */
  owns(name) {
    return !!this.mcp?.has(name);
  }

  /**
   * 执行一个扩展工具。名字不属于扩展时返回 null(调用方回落内置工具)。
   * @returns {Promise<string|null>}
   */
  async execute(name, args) {
    if (!this.mcp?.has(name)) return null;
    return await this.mcp.call(name, args);
  }

  /**
   * 切换工作目录:重读项目级 skill 与 .mcp.json,先关掉旧目录起的子进程。
   * 全局级配置不受影响,但一起重载更简单也更好推理。
   *
   * @param {{ cwd: string, locale?: string, onWarn?: (message: string) => void,
   *           onNotice?: (count: number) => void }} options
   * @returns {Promise<void>}
   */
  async reload({ cwd, locale, onWarn, onNotice } = {}) {
    await this.mcp?.close().catch(() => {});
    const next = await AgentExtensions.load({ cwd, locale, onWarn, onNotice });
    this.skills = next.skills;
    this.errors = next.errors;
    this.mcp = next.mcp;
    this.cwd = next.cwd;
  }

  /** 诊断摘要(/skills 与 /mcp 命令用) */
  summary(locale) {
    const zh = !String(locale || '').startsWith('en');
    return {
      skills: this.skills.map(skill => ({
        name: skill.name,
        scope: skill.scope,
        description: skill.description,
      })),
      servers: this.mcp ? this.mcp.status() : [],
      zh,
    };
  }

  async close() {
    await this.mcp?.close().catch(() => {});
  }
}

export default { AgentExtensions };
