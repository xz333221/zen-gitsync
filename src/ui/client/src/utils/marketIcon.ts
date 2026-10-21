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
// 智能体广场（Skill 广场 / MCP 广场）条目的图标解析。
//
// 与 providerLogo.ts 同属"不装 npm 包、直接引 CDN"的路线，但图标源不同：
// providerLogo 用 @lobehub/icons-static-png（模型服务商全，开发工具基本没有 ——
// Playwright / Chrome / Redis / MySQL 全是 404）；广场这边品牌面广，改用：
//   1. simple-icons（cdn.simpleicons.org）：几千个品牌的单色 SVG，
//      默认返回品牌色，/?slug/hex 可指定颜色。curated 名单命中即用。
//   2. GitHub 组织头像：条目带 repository（owner/repo）时取
//      https://github.com/<owner>.png?size=64。org 头像是真·彩色 logo
//      （ChromeDevTools、upstash、modelcontextprotocol 都验证过），
//      覆盖率比 curated 名单高一个量级 —— registry / npm / GitHub 三个
//      来源都能给出 repository。
//   3. 都没有 → 返回空 url，调用方渲染首字母砖（img 的 @error 也走这条）。
//
// 深色主题：simple-icons 的深色品牌 logo（GitHub / Next.js / Vercel 近黑）
// 会糊进面板底色，统一染成暖白；头像 PNG 双主题都能用，不动。

const ICON_CDN = 'https://cdn.simpleicons.org'

/** GitHub owner → 头像图。size=64 对 28-36px 的卡片图标位足够。 */
function avatarUrl(owner: string): string {
  return `https://github.com/${owner}.png?size=64`
}

function slugUrl(slug: string, dark: boolean): string {
  // 深色主题染暖白；不加 '#'，cdn.simpleicons.org 的色值参数不带井号
  return `${ICON_CDN}/${slug}${dark ? '/E8EAED' : ''}`
}

/**
 * curated 名单：haystack（name + package + repository，已小写）命中即用。
 *
 * 值是 `slug`（simple-icons）或 `avatar:owner`（GitHub 组织头像）。
 * **顺序即优先级**：更具体的规则必须放前面 —— googlemaps 在 google 之前，
 * 否则 "Google Maps" 会被 google 吃掉。短词一律加 \b（go / ci / ray），
 * 否则 "google" 会被 /\bgo\b/ 之外的写法误伤、或被更短的规则抢先。
 *
 * 只收"广场里真会出现"的品牌：浏览器自动化、数据库、云基础设施、
 * 生产力 SaaS、AI 服务商。simple-icons 没有的（playwright / aws / slack /
 * salesforce / twilio…）走头像，头像也没有的（monday / amap）不列。
 */
const ICON_RULES: Array<[RegExp, string]> = [
  // ── 浏览器自动化（MCP 第一大品类）──────────────────────────
  [/chromedevtools|chrome-dev-tools/, 'avatar:ChromeDevTools'],
  [/googlechrome|\bchrome\b/, 'googlechrome'],
  [/\bfirefox\b/, 'firefox'],
  [/puppeteer/, 'puppeteer'],
  [/playwright/, 'avatar:microsoft'],
  [/selenium/, 'selenium'],
  [/cypress/, 'cypress'],
  [/appium/, 'appium'],
  [/browserstack/, 'avatar:browserstack'],
  [/saucelabs/, 'saucelabs'],
  [/storybook/, 'storybook'],
  // ── 代码托管 / 官方 server ─────────────────────────────────
  [/\bgithub\b|githubcopilot|githubactions/, 'github'],
  [/\bgitlab\b/, 'gitlab'],
  [/\bbitbucket\b/, 'bitbucket'],
  [/context7/, 'avatar:upstash'],
  [/modelcontextprotocol/, 'avatar:modelcontextprotocol'],
  [/claude|anthropic/, 'claude'],
  [/\bopenai\b|chatgpt/, 'avatar:openai'],
  [/gemini|google\s*ai\b/, 'googlegemini'],
  [/hugging\s*face/, 'huggingface'],
  [/\bollama\b/, 'ollama'],
  [/\bdify\b/, 'dify'],
  [/\bn8n\b/, 'n8n'],
  [/langchain/, 'langchain'],
  [/perplexity/, 'avatar:perplexityai'],
  [/\bexa\b/, 'avatar:exa-labs'],
  [/firecrawl/, 'avatar:firecrawl'],
  [/\be2b\b/, 'avatar:e2b-dev'],
  [/browserbase/, 'avatar:browserbase'],
  [/apify/, 'avatar:apify'],
  // ── 数据库 / 数据栈 ────────────────────────────────────────
  [/postgres|postgresql/, 'postgresql'],
  [/\bmysql\b|mariadb/, 'mysql'],
  [/\bsqlite\b/, 'sqlite'],
  [/mongodb|\bmongo\b/, 'mongodb'],
  [/\bredis\b/, 'redis'],
  [/elasticsearch|\belastic\b/, 'elasticsearch'],
  [/clickhouse/, 'clickhouse'],
  [/snowflake/, 'snowflake'],
  [/databricks/, 'databricks'],
  [/duckdb/, 'duckdb'],
  [/influxdb/, 'influxdb'],
  [/neo4j/, 'neo4j'],
  [/cassandra/, 'apachecassandra'],
  [/rabbitmq/, 'rabbitmq'],
  [/kafka/, 'apachekafka'],
  [/\bqdrant\b/, 'qdrant'],
  [/weaviate/, 'weaviate'],
  [/pinecone/, 'avatar:pinecone'],
  [/planetscale/, 'avatar:planetscale'],
  [/neondatabase|\bneon\b/, 'avatar:neondatabase'],
  [/supabase/, 'supabase'],
  [/firebase/, 'firebase'],
  [/\bdbt\b/, 'avatar:dbt-labs'],
  [/airflow/, 'apacheairflow'],
  [/dagster/, 'avatar:dagster-io'],
  [/prefect/, 'prefect'],
  [/\bspark\b/, 'apachespark'],
  [/hadoop/, 'apachehadoop'],
  [/airbyte/, 'airbyte'],
  [/bigquery/, 'googlebigquery'],
  // ── 云 / 基础设施 ──────────────────────────────────────────
  [/\baws\b|amazon\s*web\s*services|amazons3|amazondynamodb/, 'avatar:aws'],
  [/azure/, 'microsoftazure'],
  [/google\s*cloud|\bgcp\b/, 'googlecloud'],
  [/cloudflare/, 'cloudflare'],
  [/vercel/, 'vercel'],
  [/netlify/, 'netlify'],
  [/heroku/, 'heroku'],
  [/digitalocean/, 'digitalocean'],
  [/\bdocker\b/, 'docker'],
  [/kubernetes|\bk8s\b|kubectl/, 'kubernetes'],
  [/kubeflow/, 'kubeflow'],
  [/terraform/, 'terraform'],
  [/jenkins/, 'jenkins'],
  [/circleci/, 'circleci'],
  [/\bhelm\b/, 'avatar:helm'],
  [/argocd|argo\s*cd/, 'avatar:argoproj'],
  [/\bnginx\b/, 'nginx'],
  [/\bapache\b/, 'apache'],
  [/caddy/, 'caddy'],
  [/traefik/, 'traefikproxy'],
  [/haproxy/, 'haproxy'],
  [/tailscale/, 'tailscale'],
  [/\bngrok\b/, 'ngrok'],
  [/\bconsul\b|hashicorp/, 'hashicorp'],
  [/vault/, 'hashicorp'],
  [/packer/, 'packer'],
  [/virtualbox/, 'virtualbox'],
  [/vmware/, 'vmware'],
  [/grafana/, 'grafana'],
  [/prometheus/, 'prometheus'],
  [/datadog/, 'datadog'],
  [/\bsentry\b/, 'sentry'],
  [/splunk/, 'splunk'],
  [/new\s*relic/, 'newrelic'],
  [/pagerduty/, 'pagerduty'],
  [/opsgenie/, 'opsgenie'],
  [/home\s*assistant/, 'homeassistant'],
  [/obsidian/, 'obsidian'],
  // ── 生产力 / SaaS ─────────────────────────────────────────
  [/notion/, 'notion'],
  [/figma/, 'figma'],
  [/\blinear\b/, 'linear'],
  [/atlassian/, 'atlassian'],
  [/\bjira\b/, 'jira'],
  [/confluence/, 'confluence'],
  [/airtable/, 'airtable'],
  [/clickup/, 'clickup'],
  [/asana/, 'asana'],
  [/trello/, 'trello'],
  [/basecamp/, 'basecamp'],
  [/todoist/, 'todoist'],
  [/zapier/, 'zapier'],
  [/hubspot/, 'hubspot'],
  [/zendesk/, 'zendesk'],
  [/intercom/, 'intercom'],
  [/mailchimp/, 'mailchimp'],
  [/salesforce/, 'avatar:salesforce'],
  [/slack/, 'avatar:slack'],
  [/discord/, 'discord'],
  [/telegram/, 'telegram'],
  [/whatsapp/, 'whatsapp'],
  [/gmail/, 'gmail'],
  [/google\s*drive/, 'googledrive'],
  [/google\s*sheets/, 'googlesheets'],
  [/google\s*docs/, 'googledocs'],
  [/google\s*maps/, 'googlemaps'],
  [/google\s*calendar/, 'googlecalendar'],
  [/youtube/, 'youtube'],
  [/spotify/, 'spotify'],
  [/twilio/, 'avatar:twilio'],
  [/sendgrid/, 'avatar:sendgrid'],
  [/mailgun/, 'mailgun'],
  [/stripe/, 'stripe'],
  [/paypal/, 'paypal'],
  [/shopify/, 'shopify'],
  [/posthog/, 'avatar:posthog'],
  [/segment\b/, 'avatar:segmentio'],
  [/amplitude/, 'avatar:amplitude'],
  [/mixpanel/, 'avatar:mixpanel'],
  [/contentful/, 'contentful'],
  [/sanity/, 'sanity'],
  [/wordpress|\bwp\b/, 'wordpress'],
  [/ghost\b/, 'ghost'],
  [/webflow/, 'webflow'],
  [/framer/, 'framer'],
  [/bitwarden/, 'bitwarden'],
  [/proton\s*vpn/, 'protonvpn'],
  [/1password/, '1password'],
  [/auth0/, 'auth0'],
  [/okta/, 'okta'],
  [/keycloak/, 'keycloak'],
  [/clerk/, 'avatar:clerk'],
  [/brave\b/, 'brave'],
  [/duckduckgo/, 'duckduckgo'],
  [/openapi|swagger/, 'openapiinitiative'],
  [/graphql/, 'graphql'],
  [/apollo/, 'apollographql'],
  [/postman/, 'postman'],
  [/insomnia/, 'insomnia'],
  [/hoppscotch/, 'hoppscotch'],
  [/\bcurl\b/, 'curl'],
  // ── 语言 / 框架（npm 来源的高频词）─────────────────────────
  [/react/, 'react'],
  [/vue/, 'vuedotjs'],
  [/angular/, 'angular'],
  [/svelte/, 'svelte'],
  [/next\.?js/, 'nextdotjs'],
  [/nuxt/, 'nuxtdotjs'],
  [/\bastro\b/, 'astro'],
  [/tailwind/, 'tailwindcss'],
  [/electron/, 'electron'],
  [/flutter/, 'flutter'],
  [/\bswift\b/, 'swift'],
  [/typescript/, 'typescript'],
  [/javascript/, 'javascript'],
  [/python/, 'python'],
  [/node\.?js/, 'nodedotjs'],
  [/\bdeno\b/, 'deno'],
  [/\bbun\b/, 'bun'],
  [/\brust\b/, 'rust'],
  [/\bgolang\b|\bgo\b/, 'go'],
  [/pytorch|\btorch\b/, 'pytorch'],
  [/tensorflow/, 'tensorflow'],
  [/scikit|sklearn/, 'scikitlearn'],
  [/mlflow/, 'mlflow'],
  [/\bray\b/, 'ray'],
  [/jupyter/, 'jupyter'],
  [/\bvite\b/, 'vite'],
  [/vitest/, 'vitest'],
  [/eslint/, 'eslint'],
  [/prettier/, 'prettier'],
  [/\bjest\b/, 'jest'],
  [/\bnpm\b/, 'npm'],
  [/pnpm/, 'pnpm'],
  [/\byarn\b/, 'yarn'],
  [/homebrew/, 'homebrew'],
  [/docusaurus/, 'docusaurus'],
  [/readthedocs/, 'readthedocs'],
  [/gitbook/, 'gitbook'],
  [/markdown/, 'markdown'],
  [/\blinux\b/, 'linux'],
  [/ubuntu/, 'ubuntu'],
  [/debian/, 'debian'],
  [/apple|macos/, 'apple'],
  [/windows/, 'windows'],
  [/microsoft/, 'microsoft'],
  [/\bteams\b/, 'microsoftteams'],
  [/onedrive/, 'onedrive'],
  [/power\s*bi/, 'powerbi'],
  [/bing\b/, 'bing'],
  [/google/, 'google'],
  [/baidu/, 'baidu'],
  [/bilibili/, 'bilibili'],
  [/wechat|weixin/, 'wechat'],
  [/alibaba|aliyun/, 'alibabacloud'],
]

export interface MarketIcon {
  /** 图片地址；空串 = 没有可用图片，调用方渲染首字母砖 */
  url: string
  /** 名称首字母（大写），兜底砖用 */
  letter: string
  /** 0-360，兜底砖的色相（按名称哈希，同名同色） */
  hue: number
}

const EMPTY: MarketIcon = { url: '', letter: '', hue: 0 }

/** 从 repository 里取 owner。兼容 'owner/repo' 与完整 GitHub URL 两种形态。 */
function repositoryOwner(repository: string): string {
  const raw = String(repository || '').trim()
  if (!raw) return ''
  const fromUrl = raw.match(/github\.com\/([^/\s]+)/i)
  const owner = fromUrl ? fromUrl[1] : raw.split('/')[0]
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ? owner : ''
}

function hueOf(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360000
  return hash % 360
}

/**
 * 广场条目 → 图标。解析不出图片时返回空 url + 首字母 + 色相，
 * 调用方据此渲染兜底砖（GitHub 头像 404 / 网络抖动时 img 的 @error
 * 也应当退到同一块砖，不能留破图）。
 */
export function marketIcon(item: {
  name?: string
  package?: string
  repository?: string
} | null | undefined, dark = false): MarketIcon {
  const name = String(item?.name || '').trim()
  if (!name) return EMPTY
  const letter = [...name][0]?.toUpperCase() || ''
  const hue = hueOf(name.toLowerCase())

  const haystack = `${name} ${item?.package || ''} ${item?.repository || ''}`.toLowerCase()
  for (const [rule, target] of ICON_RULES) {
    if (!rule.test(haystack)) continue
    const url = target.startsWith('avatar:')
      ? avatarUrl(target.slice('avatar:'.length))
      : slugUrl(target, dark)
    return { url, letter, hue }
  }

  const owner = repositoryOwner(item?.repository || '')
  return owner ? { url: avatarUrl(owner), letter, hue } : { url: '', letter, hue }
}
