/** Trigger-scoped WeChat context reader: reads the chat around a message and the quoted message it answers. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { validItems, type Commands } from '../infra/commands.ts'
import { listMessages, readMessage, type WechatCliConfig } from './wechat-cli.ts'
import { wechatText, type WechatMessage } from './wechat-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

const ThreadMessageSchema = z.looseObject({ id: z.string().min(1), senderId: z.string().nullable().optional(),
  senderName: z.string().nullable().optional(), type: z.number().int(), text: z.string().default(''),
  createdAt: z.string().nullable().optional() })
/** The quote a message carries, stored on its Trigger so the parent stays readable without another daemon read. */
interface StoredQuote { serverId?: string; type?: number; state?: string; senderId?: string; text?: string }
export type WechatReadConfig = WechatCliConfig & { readPageSize: number }

const view = (message: WechatMessage, at: string): ContextMessage => ({
  id: message.id, from: message.senderId ?? '', at: message.createdAt ?? at,
  text: message.body?.trim() ? message.body : wechatText(message),
  ...message.senderId?.startsWith('gh_') ? { bot: true as const } : {},
})
/** The quoted message a reply answers, as the reply itself carried it. */
function quotePart(trigger: Trigger): ContextPart {
  const quote = trigger.meta.quote as StoredQuote | undefined
  if (!quote?.serverId) return { messages: [], body: { messages: [] } }
  const recalled = quote.state === 'recalled'
  const message: ContextMessage = { id: quote.serverId, from: quote.senderId ?? '', at: trigger.at,
    text: recalled ? '' : quote.text ?? '', ...recalled ? { deleted: true as const } : {} }
  return { messages: [message], body: { status: 'quote', messages: [message] } }
}
/**
 * WeChat chats are flat, so the Thread's context is the recent chat around the message. Pages arrive newest
 * first; they are collected until the message is found (bounded) and then returned oldest first.
 */
async function chatAround(commands: Commands, trigger: Trigger, config: WechatReadConfig): Promise<ContextPart> {
  const chatId = String(trigger.meta.chatId ?? '')
  const sourceId = String(trigger.meta.messageId ?? '')
  if (!chatId || !sourceId) throw new Error('A WeChat source trigger is required')
  const messages: ContextMessage[] = []
  let cursor: string | undefined
  let found = false
  for (let page = 0; page < 5; page++) {
    const result = await listMessages(commands, config, chatId, cursor)
    const items = validItems(ThreadMessageSchema, result.items).map(item => {
      const text = item.text
      const recalled = /^\[Message recalled\]$/.test(text)
      return { id: item.id, from: item.senderName || item.senderId || '', at: item.createdAt ?? trigger.at,
        text: recalled ? '' : text, ...item.senderId?.startsWith('gh_') ? { bot: true as const } : {},
        ...recalled ? { deleted: true as const } : {} } satisfies ContextMessage
    })
    messages.unshift(...items.reverse())
    found ||= items.some(item => item.id === sourceId)
    cursor = result.next
    if (!cursor || found) break
  }
  // The Trigger keeps the full body; a message list only carries a 160-character preview.
  for (const message of messages) if (message.id === sourceId) message.text = trigger.text
  return { messages, body: { messages } }
}
export const wechatThreadContext: ThreadContext<WechatReadConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  async read(commands, trigger, part, _cursor, config) {
    if (trigger.source !== 'wechat') throw new Error('A WeChat source trigger is required')
    if (part === 'parent') return quotePart(trigger)
    if (part === 'root') {
      const chatId = String(trigger.meta.chatId ?? '')
      const own = String(trigger.meta.serverId ?? trigger.meta.messageId ?? '')
      // A quoted reply's Thread root is the quoted message, which only the reply carries.
      if (!chatId || String(trigger.meta.root ?? '') !== own) return quotePart(trigger)
      const message = view(await readMessage(commands, config, chatId, String(trigger.meta.messageId)), trigger.at)
      return { messages: [message], body: { messages: [message] } }
    }
    return chatAround(commands, trigger, config)
  },
}
