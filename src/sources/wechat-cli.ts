/** JSON access to the Agent WeChat `wx` CLI: account selection, the replayable event cursor, chat names and pages. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { MessageSchema, PageSchema, SOURCE, type WechatMessage } from './wechat-trigger.ts'

/** The CLI and account every WeChat command needs; the Source's saved configuration supplies them. */
export interface WechatCliConfig { cli: string; account: string }
/** Global flags of a `wx` call; `--json` makes output machine-readable and one event per line on a watch. */
export const wechatArgs = (config: WechatCliConfig, ...args: string[]): string[] =>
  ['--json', ...(config.account ? ['--account', config.account] : []), ...args]
/** Runs `wx` and parses its JSON answer, validating it before use. */
export async function wechatJson<T>(commands: Commands, config: WechatCliConfig, args: string[], schema: z.ZodType<T>): Promise<T> {
  if (!config.cli) throw new Error('The WeChat Source has no CLI')
  return schema.parse(JSON.parse(await commands.run(config.cli, wechatArgs(config, ...args))))
}
/** The daemon's current event position, taken from a list page instead of replaying the whole log on a first run. */
export async function eventCursor(commands: Commands, config: WechatCliConfig): Promise<string> {
  const page = await wechatJson(commands, config, ['chats', 'list', '--limit', '1'], PageSchema)
  if (!page.asOfEventCursor) throw new Error('The WeChat CLI did not report the current event cursor')
  return page.asOfEventCursor
}
/** Reads one full message; the daemon may have it even when its local database changed in the meantime. */
export async function readMessage(commands: Commands, config: WechatCliConfig, chatId: string, messageId: string): Promise<WechatMessage> {
  return wechatJson(commands, config, ['messages', 'get', chatId, messageId], MessageSchema)
}
/** One page of a chat's messages, newest first; `nextCursor` continues with older messages. */
export async function listMessages(commands: Commands, config: WechatCliConfig & { readPageSize: number }, chatId: string,
  cursor?: string): Promise<{ items: unknown[]; next: string | undefined }> {
  const args = ['messages', 'list', chatId, '--limit', String(config.readPageSize), ...(cursor ? ['--cursor', cursor] : [])]
  const page = await wechatJson(commands, config, args, PageSchema)
  return { items: page.items, next: page.nextCursor ?? undefined }
}
const ChatSchema = z.looseObject({ id: z.string().min(1), displayName: z.string().nullable().optional() })
/**
 * Resolves every chat name the daemon knows and stores it with the Source labels, so settings can offer
 * chats and Threads can show names instead of opaque IDs.
 */
export async function refreshWechatLabels(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const config = ctx.config<WechatCliConfig & Record<string, unknown>>(SOURCE)
  if (!config?.cli) return {}
  const commands = ctx.commands.withSignal(signal)
  const names: Record<string, string> = {}
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await wechatJson(commands, config, ['chats', 'list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], PageSchema)
    for (const chat of validItems(ChatSchema, result.items)) if (chat.displayName) names[chat.id] = chat.displayName
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
const MemberSchema = z.looseObject({ id: z.string().min(1), displayName: z.string().nullable().optional(),
  roomDisplayName: z.string().nullable().optional() })
/** Reads every saved member of a group, for syncing the Source's allowed list with it. */
export async function groupMembers(commands: Commands, config: WechatCliConfig, groupId: string): Promise<{ id: string; name?: string }[]> {
  const members = new Map<string, string | undefined>()
  const tally = { skipped: 0 }
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await wechatJson(commands, config, ['groups', 'members', 'list', groupId, '--limit', '100',
      ...(cursor ? ['--cursor', cursor] : [])], PageSchema)
    for (const member of validItems(MemberSchema, result.items, tally)) {
      const name = member.displayName || member.roomDisplayName || undefined
      if (!members.has(member.id)) members.set(member.id, name)
    }
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  // Clearing the allowed list from a partially readable roster would revoke everyone's access.
  if (tally.skipped) throw new Error('The WeChat CLI returned an incomplete group member list')
  return [...members].map(([id, name]) => ({ id, ...name ? { name } : {} }))
}
