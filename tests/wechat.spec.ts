import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { apply as applyWechat, SOURCE, wechatChannel, wechatKind, wechatText, wechatThreadId, wechatTrigger, wechatTriggerId }
  from '../src/sources/wechat.ts'
import { applyEvent, CursorExpired, heartbeat, watch } from '../src/sources/wechat-loops.ts'
import { accountStatus, loginAccount } from '../src/sources/wechat-cli.ts'
import { sendWechat } from '../src/sources/wechat-channel.ts'
import { wechatThreadContext } from '../src/sources/wechat-read.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Health } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WechatMessage } from '../src/sources/wechat.ts'

const CHAT = 'team@chatroom'
const opened: Store[] = []
afterEach(() => { for (const store of opened.splice(0)) store.close() })
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wechat-')), 'db.sqlite'))
  opened.push(store)
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { wechat: { allowed: [{ id: 'wxid_alice', name: 'Alice' }] } } },
    sources: { wechat: { enabled: true, config: { cli: '/bin/wx', account: 'bot',
      chats: [{ id: CHAT, name: 'Team', listen: 'mentions' }, { id: 'all@chatroom', listen: 'all' }], directMessages: true, ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(wechatKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const ctx = sourceContextOf(parts, wechatKind)
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...ctx, store, engine, commands, receive, health, ctx }
}
/** A message as `wx messages get --json` prints it. */
const message = (overrides: Partial<WechatMessage> = {}): WechatMessage => ({ id: 'msg_1', threadId: CHAT, serverId: '9001',
  senderId: 'wxid_alice', type: 1, body: 'fix the typo', createdAt: '2026-09-09T00:00:00Z', direction: 'incoming',
  mentions: { state: 'known', userIds: [], self: false, all: false }, ...overrides } as WechatMessage)
const event = (cursor: string, data: Record<string, unknown>, kind = 'message.committed') => JSON.stringify({ cursor, kind, data })
/** Stubs `wx` calls and returns their argument lists. */
const cli = (h: ReturnType<typeof host>, answer: (args: string[]) => unknown) =>
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => JSON.stringify(answer(args)))

describe('wechat source', () => {
  it('registers its kind and reports a missing CLI without starting the consumer', async () => {
    const value = host({ sources: emptyRegistry() }, { cli: '' })
    const disposers: (() => unknown)[] = []
    applyWechat({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.wechat).toMatchObject({ state: 'paused', code: 'wechatCliUnset' }))
    expect(value.sources.kind('wechat')).toBe(wechatKind)
    for (const dispose of disposers) await dispose()
    expect(value.sources.kind('wechat')).toBeUndefined()
  })
  it('translates a group message that mentions the bot into an explicit trigger', () => {
    const trigger = wechatTrigger(message({ mentions: { state: 'known', userIds: ['wxid_bot'], self: true, all: false } }))!
    expect(trigger).toMatchObject({ id: key('wechat', '9001'), source: SOURCE, threads: [{ source: SOURCE, id: `${CHAT}:9001` }],
      actor: { source: SOURCE, id: 'wxid_alice' }, human: true, addressed: 'mention', at: '2026-09-09T00:00:00.000Z',
      text: 'fix the typo', channel: { source: SOURCE, thread: `wechat:${CHAT}`, address: { chatId: CHAT, messageId: 'msg_1', serverId: '9001' } },
      meta: { chatId: CHAT, messageId: 'msg_1', serverId: '9001', direct: false, mentioned: true, root: '9001', type: 1 } })
    expect(trigger.id).toBe(wechatTriggerId(message()))
  })
  it('marks a direct message as addressed, and drops its own, recalled and system messages', () => {
    expect(wechatTrigger(message({ threadId: 'wxid_alice', serverId: undefined }))).toMatchObject({ addressed: 'direct',
      threads: [{ id: 'wxid_alice:msg_1' }], id: key('wechat', 'msg_1') })
    expect(wechatTrigger(message({ direction: 'outgoing' }))).toBeUndefined()
    expect(wechatTrigger(message({ recall: { observedAt: '2026-09-09T00:00:00Z' } }))).toBeUndefined()
    expect(wechatTrigger(message({ type: 10000, senderId: null }))).toBeUndefined()
  })
  it('joins the thread of the message a reply quotes and names that message as its parent', () => {
    const trigger = wechatTrigger(message({ id: 'msg_2', serverId: '9002',
      quote: { serverId: '9001', type: 1, embeddedText: 'fix the typo' } }))!
    expect(trigger.threads).toEqual([{ source: SOURCE, id: `${CHAT}:9001` }])
    expect(trigger.meta).toMatchObject({ parentId: key('wechat', '9001'), root: '9001',
      quote: { serverId: '9001', type: 1, text: 'fix the typo' } })
    expect(wechatKind.repliesTo!(trigger)).toBe(key('wechat', '9001'))
    expect(wechatThreadId(CHAT, '9001')).toBe(`${CHAT}:9001`)
    expect(wechatChannel(CHAT, 'msg_2', '9002', true).address).toMatchObject({ direct: 'true', serverId: '9002' })
  })
  it('gives a readable label to a message without body text', () => {
    expect(wechatText(message({ type: 3, body: null }))).toBe('[Photo]')
    expect(wechatText(message({ type: 49, appMessageType: 6, body: null }))).toBe('[File]')
    expect(wechatText(message({ type: 49, appMessageType: 5, body: 'link' }))).toBe('link')
  })
  it('takes in a committed message once, advances the cursor and evaluates an allowed mention', async () => {
    const h = host()
    h.store.set(KV.sources.labels(SOURCE), { [CHAT]: 'Team' })
    const run = cli(h, () => message({ mentions: { state: 'known', userIds: ['wxid_bot'], self: true, all: false } }))
    const cursorKey = KV.wechat.cursor('bot')
    await applyEvent(h.ctx, h.commands, { cli: '/bin/wx', account: 'bot' }, cursorKey, event('12', { messageId: 'msg_1', threadId: CHAT }))
    expect(run).toHaveBeenCalledWith('/bin/wx', expect.arrayContaining(['messages', 'get', CHAT, 'msg_1']))
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get(cursorKey)).toBe('12')
    expect(h.engine.candidate(key('wechat', '9001'))?.strength).toBe('explicit')
    expect(h.store.threads.get(`wechat:${CHAT}:9001`)?.meta.facts).toMatchObject({ chat: { value: 'Team' } })
    // Replaying the same event stores the same Trigger once.
    await applyEvent(h.ctx, h.commands, { cli: '/bin/wx', account: 'bot' }, cursorKey, event('13', { messageId: 'msg_1', threadId: CHAT }))
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.store.get(cursorKey)).toBe('13')
  })
  it('advances past other events and past a message the daemon no longer has', async () => {
    const h = host()
    await applyEvent(h.ctx, h.commands, { cli: '/bin/wx', account: 'bot' }, KV.wechat.cursor('bot'),
      event('20', { messageId: 'x' }, 'thread.updated'))
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.wechat.cursor('bot'))).toBe('20')
    vi.spyOn(h.commands, 'run').mockRejectedValue(new CliError('message not found', undefined, 2))
    await applyEvent(h.ctx, h.commands, { cli: '/bin/wx', account: 'bot' }, KV.wechat.cursor('bot'),
      event('21', { messageId: 'gone', threadId: CHAT }))
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.wechat.cursor('bot'))).toBe('21')
  })
  it('resumes at the daemon position when its retained event history expired', async () => {
    const h = host()
    cli(h, () => ({ items: [], nextCursor: null, asOfEventCursor: '99' }))
    await expect(applyEvent(h.ctx, h.commands, { cli: '/bin/wx', account: 'bot' }, KV.wechat.cursor('bot'),
      JSON.stringify({ error: { code: 'event_cursor_expired', message: 'expired' } }))).rejects.toBeInstanceOf(CursorExpired)
    expect(h.store.get(KV.wechat.cursor('bot'))).toBe('99')
  })
  it('sends text with a stable idempotency key, and drops only a send WeChat refused', async () => {
    const h = host()
    const sent = vi.spyOn(h.commands, 'run').mockResolvedValue('{}')
    const message: OutboundMessage = { id: 'reply-1', kind: 'reply', text: 'On it',
      channel: { source: SOURCE, thread: `wechat:${CHAT}`, address: { chatId: CHAT, messageId: 'msg_1' } } }
    expect(await sendWechat({ commands: h.commands }, message, { cli: '/bin/wx', account: 'bot' })).toBe('sent')
    expect(sent).toHaveBeenCalledWith('/bin/wx', ['--json', '--account', 'bot', 'messages', 'send', CHAT, '--text', 'On it',
      '--idempotency-key', 'reply-1'])
    sent.mockRejectedValueOnce(new CliError('WeChat refused', undefined, 9))
    expect(await sendWechat({ commands: h.commands }, message, { cli: '/bin/wx', account: 'bot' })).toBe('gone')
    sent.mockRejectedValueOnce(new CliError('daemon unreachable', undefined, 3))
    await expect(sendWechat({ commands: h.commands }, message, { cli: '/bin/wx', account: 'bot' })).rejects.toThrow('daemon unreachable')
  })
  it('reads the chat around a message oldest first and the quote it answers', async () => {
    const h = host()
    const pages: Record<string, unknown> = {
      '': { items: [{ id: 'msg_3', senderId: 'wxid_bob', text: 'newer', type: 1, createdAt: '2026-09-09T00:02:00Z' },
        { id: 'msg_2', senderId: 'wxid_alice', text: 'preview', type: 1, createdAt: '2026-09-09T00:01:00Z' },
        { id: 'msg_1', senderId: 'wxid_alice', text: 'older', type: 1, createdAt: '2026-09-09T00:00:00Z' }], nextCursor: null },
      'next': { items: [{ id: 'msg_0', senderId: 'wxid_bob', text: 'oldest', type: 1, createdAt: '2026-09-08T23:59:00Z' }], nextCursor: null },
    }
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1]! : ''
      return JSON.stringify(pages[cursor] ?? { items: [], nextCursor: null })
    })
    const trigger = wechatTrigger(message({ id: 'msg_2', serverId: '9002',
      quote: { serverId: '9001', type: 1, embeddedText: 'fix the typo' } }))!
    const thread = await wechatThreadContext.read(h.commands, trigger, 'thread', undefined,
      { cli: '/bin/wx', account: 'bot', readPageSize: 20 })
    expect(thread.messages.map(message => message.id)).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(thread.messages[1]!.text).toBe('fix the typo')
    expect(thread.next).toBeUndefined()
    const parent = await wechatThreadContext.read(h.commands, trigger, 'parent', undefined,
      { cli: '/bin/wx', account: 'bot', readPageSize: 20 })
    expect(parent.messages).toEqual([expect.objectContaining({ id: '9001', text: 'fix the typo' })])
  })
  it('scopes chats as listed, observed, other or direct, and lists them as admission rows', () => {
    const config = wechatKind.schema.parse({ cli: '/bin/wx', chats: [{ id: CHAT, listen: 'all' }], otherChats: 'mentions' })
    expect(wechatKind.scope!({ meta: { chatId: CHAT, direct: false } }, config)).toEqual({ listened: true, observed: true, row: CHAT })
    expect(wechatKind.scope!({ meta: { chatId: 'other@chatroom', direct: false } }, config)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(wechatKind.scope!({ meta: { chatId: 'elsewhere', direct: false } }, { ...config, otherChats: 'none' }))
      .toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(wechatKind.scope!({ meta: { chatId: 'wxid_alice', direct: true } }, config)).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(wechatKind.policy!.rows!(config).map(row => row.id)).toEqual([CHAT, 'other', 'direct'])
  })
  it('keeps a policy part and syncs its allowed list from a group', async () => {
    const h = host()
    const part = wechatKind.policy!.schema.parse({ allowed: [{ id: 'wxid_alice', name: 'Alice' }], syncChat: CHAT })
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify({ items: [
      { id: 'wxid_alice', displayName: 'Alice Chen' }, { id: 'wxid_bob', displayName: 'Bob' }], nextCursor: null }))
    const synced = await wechatKind.policy!.sync!.run(h, part, new AbortController().signal) as typeof part
    expect(synced.allowed).toEqual([{ id: 'wxid_alice', name: 'Alice Chen' }, { id: 'wxid_bob', name: 'Bob' }])
    expect(wechatKind.policy!.sync!.ready(part)).toBe(true)
    expect(wechatKind.policy!.sync!.ready({ ...part, syncChat: '' })).toBe(false)
    // A partial roster would otherwise clear the list of everyone the CLI could not read.
    vi.spyOn(h.commands, 'run').mockResolvedValueOnce(JSON.stringify({ items: [{ displayName: 'No ID' }], nextCursor: null }))
    await expect(wechatKind.policy!.sync!.run(h, part, new AbortController().signal)).rejects.toThrow('incomplete group member list')
  })
  it('reads the account state and asks the daemon for a saved login', async () => {
    const h = host()
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify({ alias: 'superagent', authenticated: true,
      connection: 'online' }))
    expect(await accountStatus(h.commands, { cli: '/bin/wx', account: 'superagent' })).toEqual({ account: 'superagent',
      authenticated: true, connection: 'online', online: true })
    expect(run).toHaveBeenCalledWith('/bin/wx', ['--json', '--account', 'superagent', 'auth', 'status'])
    run.mockResolvedValue('{}')
    await loginAccount(h.commands, { cli: '/bin/wx', account: 'superagent' })
    // `--no-qr` keeps the retry on the saved login; WeChat then asks for confirmation on the account's phone.
    expect(run).toHaveBeenLastCalledWith('/bin/wx', ['--json', '--account', 'superagent', 'auth', 'login', '--no-qr', '--timeout', '75'])
  })
  it('turns a silent account disconnect into an error while the watcher keeps running, and back to ready after recovery', async () => {
    const h = host()
    const reports: Health[] = []
    vi.spyOn(h.ctx, 'report').mockImplementation((_entry, value) => { reports.push(value) })
    const controller = new AbortController()
    let clock = 1_000_000
    let online = false
    const login = vi.fn(async () => { online = true })
    await heartbeat(h.ctx, { cli: '/bin/wx', account: 'bot' }, controller.signal, {
      now: () => clock,
      status: async () => ({ account: 'bot', authenticated: online, connection: online ? 'online' : 'disconnected', online }),
      login,
      pause: async ms => {
        // The recovered heartbeat reports ready, then the test ends it on its next wait.
        if (reports.some(report => report.state === 'ready')) controller.abort()
        else clock += ms
      },
    })
    expect(reports[0]).toMatchObject({ state: 'error' })
    expect(reports[0]!.detail).toContain('WeChat account bot')
    expect(reports[0]!.detail).toContain('disconnected')
    expect(reports[0]!.detail).toContain('phone')
    expect(reports.at(-1)).toMatchObject({ state: 'ready' })
    expect(login).toHaveBeenCalledOnce()
  })
  it('retries the saved login on an exponential backoff, one attempt at a time, not on every heartbeat', async () => {
    const h = host()
    const controller = new AbortController()
    let clock = 1_000_000
    let checks = 0
    let inFlight = 0
    let most = 0
    const attempts: number[] = []
    await heartbeat(h.ctx, { cli: '/bin/wx', account: 'bot' }, controller.signal, {
      now: () => clock,
      status: async () => {
        checks += 1
        return { account: 'bot', authenticated: false, connection: 'disconnected', online: false }
      },
      login: async () => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await Promise.resolve()
        attempts.push(clock)
        inFlight -= 1
        if (attempts.length === 4) controller.abort()
      },
      pause: async ms => { clock += ms },
    })
    // 30 s after the first attempt, then 60 s and 2 min, while the 45 s heartbeat keeps checking in between.
    expect(attempts).toEqual([1_000_000, 1_030_000, 1_090_000, 1_210_000])
    expect(most).toBe(1)
    expect(checks).toBeGreaterThan(attempts.length)
  })
  it('keeps the event cursor across a reconnect, so resuming neither drops nor repeats a message', async () => {
    const h = host()
    const cursorKey = KV.wechat.cursor('bot')
    h.store.set(cursorKey, '11')
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => JSON.stringify(message({ id: args[6]!,
      serverId: args[6]!.replace('msg_', '90'), threadId: CHAT })))
    const config = { cli: '/bin/wx', account: 'bot' }
    await applyEvent(h.ctx, h.commands, config, cursorKey, event('12', { messageId: 'msg_12', threadId: CHAT }))
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get(cursorKey)).toBe('12')
    // A disconnect and its successful login must leave the retained cursor alone.
    const controller = new AbortController()
    let online = false
    await heartbeat(h.ctx, config, controller.signal, {
      now: () => 0,
      status: async () => ({ account: 'bot', authenticated: online, connection: online ? 'online' : 'disconnected', online }),
      login: async () => { online = true },
      pause: async () => controller.abort(),
    })
    expect(h.store.get(cursorKey)).toBe('12')
    // The reconnect resumes at that event; the Engine still recognizes the replayed Trigger as a duplicate.
    await applyEvent(h.ctx, h.commands, config, cursorKey, event('12', { messageId: 'msg_12', threadId: CHAT }))
    expect(await h.receive.mock.results.at(-1)!.value).toBe('duplicate')
    expect(h.store.get(cursorKey)).toBe('12')
    // A later event still arrives once, so the replay protection did not skip it: the duplicate was handed to the
    // Engine and dropped there, while the new message reached it normally.
    await applyEvent(h.ctx, h.commands, config, cursorKey, event('13', { messageId: 'msg_13', threadId: CHAT }))
    expect(h.receive).toHaveBeenCalledTimes(3)
    expect(await h.receive.mock.results.at(-1)!.value).not.toBe('duplicate')
    expect(h.store.get(cursorKey)).toBe('13')
  })
  it('reports an error from the running message watch, which keeps its cursor for the resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wechat-watch-'))
    const log = join(dir, 'wx.log')
    const script = join(dir, 'wx')
    // A CLI whose watch process stays alive after printing one event, then answers `auth status` as disconnected.
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args.includes('watch')) {
  process.stdout.write(JSON.stringify({ cursor: '12', kind: 'message.committed', data: { messageId: 'msg_12', threadId: 'team@chatroom' } }) + '\\n')
  setInterval(() => {}, 60000)
}
`, { mode: 0o755 })
    const h = host({}, { cli: script, account: 'bot' })
    h.store.set(KV.wechat.cursor('bot'), '11')
    // The heartbeat and the consumer build their own Commands via withSignal, so stub the prototype.
    const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => args.includes('auth')
      ? JSON.stringify({ alias: 'superagent', authenticated: false, connection: 'disconnected' })
      : JSON.stringify(message({ id: 'msg_12', serverId: '9012', threadId: CHAT })))
    const controller = new AbortController()
    const running = watch(h.ctx, controller.signal)
    try {
      await vi.waitFor(() => expect(h.health.wechat).toMatchObject({ state: 'error',
        detail: expect.stringContaining('connection: disconnected') }))
      await vi.waitFor(() => expect(h.receive).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(h.store.get(KV.wechat.cursor('bot'))).toBe('12'))
      // The watcher was started at the retained cursor and the reconnect did not move it.
      expect(readFileSync(log, 'utf8')).toContain('"messages","watch","--after","11"')
    } finally {
      controller.abort()
      await running
      run.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
