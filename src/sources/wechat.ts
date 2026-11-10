/** WeChat source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sendWechat, wechatLink } from './wechat-channel.ts'
import { groupMembers, refreshWechatLabels } from './wechat-cli.ts'
import { runWechat } from './wechat-loops.ts'
import { wechatThreadContext } from './wechat-read.ts'
import { SOURCE, wechatParent } from './wechat-trigger.ts'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export { SOURCE, wechatChannel, wechatText, wechatThreadId, wechatTrigger, wechatTriggerId } from './wechat-trigger.ts'
export type { WechatEvent, WechatMessage } from './wechat-trigger.ts'
export { applyEvent, consume, CursorExpired, runWechat } from './wechat-loops.ts'
export { sendWechat } from './wechat-channel.ts'
export { wechatThreadContext } from './wechat-read.ts'

/** A WeChat chat or contact ID: `wxid_…`, an `…@chatroom` group, `filehelper`, or a `gh_…` official account. */
const ChatIdSchema = z.string().trim().min(1).max(200)
const WechatConfigSchema = z.object({
  cli: z.string().trim().default(''),
  account: z.string().trim().max(200).default(''),
  chats: z.array(z.object({ id: ChatIdSchema, name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.id)).size === chats.length, 'Duplicate chat IDs').default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  readPageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type WechatConfig = z.infer<typeof WechatConfigSchema>
export const wechatKind: SourceKind<WechatConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshWechatLabels(sourceContext(host, wechatKind), signal),
  title: { zh: '微信', en: 'WeChat' },
  description: { zh: '接收下列微信会话中发给机器人的消息和私聊消息，并从微信事件流补收错过的消息。',
    en: 'Receives messages to the bot in these WeChat chats and direct messages, and recovers missed messages from the WeChat event stream.' },
  schema: WechatConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人的微信 CLI', en: 'Bot WeChat CLI' },
      hint: { zh: '命令名或绝对路径，指向已登录的 Agent WeChat `wx`（先运行 wx serve，再用 wx auth login 扫码）。来源以 wx 调用它，并在下一轮读取这个设置。',
        en: 'A command name or absolute path to a signed-in Agent WeChat `wx` (run wx serve, then sign in with wx auth login). The Source calls it as wx and reads this setting on its next round.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。',
        en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '会话', en: 'Chat' },
          choose: { zh: '选择机器人已加入的会话', en: 'Choose a chat the bot has joined' }, refresh: { zh: '刷新会话列表', en: 'Refresh chats' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的会话。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。',
        en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'account', type: 'text', advanced: true, label: { zh: '账号', en: 'Account' },
      hint: { zh: 'wx 的账号 ID 或别名；留空时用 wx 已选的账号。换账号后事件游标从新账号现在的位置开始。',
        en: 'The account ID or alias for wx; empty uses the account wx selected. After changing accounts, the event cursor starts at the new account\'s current position.' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' },
      hint: { zh: '智能体读取会话上下文时，每页的消息数。', en: 'Messages per page when agents read chat context.' } },
  ],
  health: ['wechat'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.id === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.id }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      wechatKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendWechat, link: wechatLink,
  },
  threadContext: wechatThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b(?:wxid_[A-Za-z0-9_-]+|[A-Za-z0-9_@.-]+@chatroom)\b/g) ?? [])] }),
  // A quoted message is named after WeChat's server ID, as is the Trigger of the message that quotes it.
  repliesTo: trigger => wechatParent(trigger),
  policy: {
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate sender IDs').default([]),
      syncChat: z.string().trim().max(200).default(''),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncChat', type: 'text', label: { zh: '同步来源群', en: 'Sync chat' }, choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '同步时，名单变成这个群的成员：新成员加入，离开的人移除，名字取群里的名字。启动时和点同步时进行。',
          en: 'Syncing makes the list the members of this group: new members join, people who left are removed, and names follow the group. It runs at startup and on Sync.' } },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。',
      en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = WechatConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.id, label: chat.name || chat.id, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他会话', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const ctx = sourceContext(host, wechatKind)
        const config = ctx.config<WechatConfig>(SOURCE)
        if (!config?.cli) throw new Error('The WeChat Source has no CLI')
        const members = await groupMembers(ctx.commands.withSignal(signal), config, String(part.syncChat))
        const names = new Map(members.map(member => [member.id, member.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        // Preserve the existing order and refresh names in place so the policy version stays stable when nothing changed.
        return { ...part, allowed: [
          ...part.allowed.filter(entry => names.has(entry.id)).map(entry => {
            const name = names.get(entry.id)
            return { ...entry, ...name ? { name } : {} }
          }),
          ...members.filter(member => !known.has(member.id)).map(member => ({ id: member.id, ...member.name ? { name: member.name } : {} })),
        ] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WECHAT_ACCOUNT', description: { zh: '微信账号；wx 以它行事', en: 'The WeChat account; wx acts as it' } },
      { key: 'DSH_SUPERAGENT_WECHAT_CHAT', description: { zh: '接下工单的微信会话 ID；工单不是从微信来的时为空',
        en: 'ID of the WeChat chat that started the ticket; empty when the ticket did not start on WeChat' } },
    ],
    values: ({ config, trigger }) => ({ DSH_SUPERAGENT_WECHAT_ACCOUNT: config.account,
      DSH_SUPERAGENT_WECHAT_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
}
export const name = 'dsh-superagent-wechat'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wechatKind), 'wechat: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runWechat(sourceContext(ctx.orchestrator, wechatKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
