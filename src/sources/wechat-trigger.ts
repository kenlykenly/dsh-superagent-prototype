/** Normalizes Agent WeChat events and messages into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'wechat'
/** One line of `wx --json messages watch`: an event from the daemon's replayable stream. */
export const EventSchema = z.looseObject({
  cursor: z.string().regex(/^\d+$/), kind: z.string(), data: z.record(z.string(), z.unknown()),
  createdAt: z.string().optional(), accountId: z.string().optional(),
})
export type WechatEvent = z.infer<typeof EventSchema>
/** The event a committed message carries before the full message is read. */
export const CommittedSchema = z.looseObject({ messageId: z.string().min(1), threadId: z.string().min(1) })
/** A message as `wx --json messages get` prints it; `body` is null for media without a readable summary. */
export const MessageSchema = z.looseObject({
  id: z.string().min(1), threadId: z.string().min(1), serverId: z.string().nullable().optional(),
  senderId: z.string().nullable().optional(), type: z.number().int(), appMessageType: z.number().int().nullable().optional(),
  direction: z.enum(['incoming', 'outgoing']).nullable().optional(), body: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(), recall: z.unknown().nullable().optional(),
  mentions: z.looseObject({ state: z.string().optional(), userIds: z.array(z.string()).default([]),
    self: z.boolean().nullable().optional(), all: z.boolean().nullable().optional() }).optional(),
  quote: z.looseObject({ serverId: z.string().min(1), type: z.number().int(), state: z.string().optional(),
    senderId: z.string().optional(), embeddedText: z.string().nullable().optional() }).nullable().optional(),
})
export type WechatMessage = z.infer<typeof MessageSchema>
/** One page of a `wx` list command. */
export const PageSchema = z.looseObject({ items: z.array(z.unknown()), nextCursor: z.string().nullable().optional(),
  asOfEventCursor: z.string().optional() })

/** Constructs a WeChat reply channel address; `serverId` is WeChat's own ID of the triggering message. */
export const wechatChannel = (chatId: string, messageId: string, serverId: string | undefined, direct: boolean): ChannelRef =>
  ({ source: SOURCE, thread: `wechat:${chatId}`, address: { chatId, messageId, ...serverId ? { serverId } : {}, ...direct ? { direct: 'true' } : {} } })
/** A WeChat chat is flat: a quoted reply joins the Thread of the message it quotes, other messages start one. */
export const wechatThreadId = (chatId: string, root: string): string => `${chatId}:${root}`
/** Deterministic Trigger ID for a WeChat message; WeChat's server ID is stable across daemon re-reads, so it is preferred. */
export const wechatTriggerId = (message: WechatMessage): string => key(SOURCE, message.serverId || message.id)
/** Converts a WeChat message into a Trigger, returning undefined for its own, recalled and system messages. */
export function wechatTrigger(message: WechatMessage, at?: string): Trigger | undefined {
  if (message.direction === 'outgoing' || message.recall) return undefined
  // 10000 is a system notice and 10002 its newer form; neither has a person or bot behind it.
  if (message.type === 10000 || message.type === 10002 || !message.senderId) return undefined
  const direct = !message.threadId.endsWith('@chatroom')
  const serverId = message.serverId || undefined
  const root = message.quote?.serverId || serverId || message.id
  const thread = wechatThreadId(message.threadId, root)
  const parentId = message.quote ? key(SOURCE, message.quote.serverId) : undefined
  const quote = message.quote ? { serverId: message.quote.serverId, type: message.quote.type, ...(message.quote.state ? { state: message.quote.state } : {}),
    ...(message.quote.senderId ? { senderId: message.quote.senderId } : {}), ...(message.quote.embeddedText ? { text: message.quote.embeddedText } : {}) } : undefined
  return {
    id: wechatTriggerId(message), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.senderId }, human: !message.senderId.startsWith('gh_'),
    ...(direct ? { addressed: 'direct' as const } : message.mentions?.self === true ? { addressed: 'mention' as const } : {}),
    at: messageTime(message.createdAt, at), text: wechatText(message),
    channel: wechatChannel(message.threadId, message.id, serverId, direct),
    meta: { chatId: message.threadId, messageId: message.id, ...(serverId ? { serverId } : {}), direct,
      mentioned: message.mentions?.self === true, root, type: message.type,
      ...(message.appMessageType ? { appMessageType: message.appMessageType } : {}),
      ...(parentId ? { parentId, ...(quote ? { quote } : {}) } : {}) },
  }
}
/** WeChat's saved time, falling back to the event that announced the message and then to now. */
export function messageTime(value: string | null | undefined, fallback?: string): string {
  for (const candidate of [value, fallback]) {
    if (!candidate) continue
    const time = Date.parse(candidate)
    if (Number.isFinite(time)) return new Date(time).toISOString()
  }
  return new Date().toISOString()
}
/** Readable text for a message whose body is empty, as WeChat's own message list preview does. */
export function wechatText(message: Pick<WechatMessage, 'body' | 'type' | 'appMessageType'>): string {
  if (message.body?.trim()) return message.body
  if (message.type === 3) return '[Photo]'
  if (message.type === 34) return '[Voice]'
  if (message.type === 43) return '[Video]'
  if (message.type === 47) return '[Sticker]'
  if (message.type === 48) return '[Location]'
  if (message.type === 49) return message.appMessageType === 6 ? '[File]' : '[Link]'
  return '[Message]'
}
/** The Trigger whose message this one quotes, when it quotes one. */
export const wechatParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : undefined
