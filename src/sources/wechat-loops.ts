/** WeChat background loops: the replayable event consumer and the chat-name refresh. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { eventCursor, accountStatus, loginAccount, readMessage, refreshWechatLabels, wechatArgs, type WechatAccountStatus, type WechatCliConfig }
  from './wechat-cli.ts'
import { CommittedSchema, EventSchema, SOURCE, wechatTrigger } from './wechat-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { consumerRetry, pause } from './poll.ts'
import type { WechatConfig } from './wechat.ts'

/** The daemon no longer retains the events after our cursor, so the consumer must resume from now. */
class CursorExpired extends Error {}
/** How often the heartbeat reads the account's login state; a watch process can stay alive after WeChat ended its session. */
export const WECHAT_HEARTBEAT_MS = 45_000
/** Waits before each saved-login retry: 30 s, 60 s, 2 min, 4 min, 8 min, then every 10 min. */
export const WECHAT_RECONNECT_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000] as const
export const runWechat = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch(ctx, signal), chatNamesLoop(ctx, signal)])
const enabled = (ctx: SourceContext): WechatConfig | undefined => ctx.config<WechatConfig>(SOURCE)
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
}
/** True for a message the daemon no longer has; the event is skipped instead of blocking every later one. */
const unreadable = (error: unknown): boolean => (error instanceof CliError && (error.exitCode === 2 || error.exitCode === 9))
  || error instanceof z.ZodError || error instanceof SyntaxError
/**
 * Handles one JSON line of the message stream: an event, or a daemon error that ends the run.
 * The cursor advances only after the Trigger reached the Engine, so an interrupted run replays what it did not store.
 */
export async function applyEvent(ctx: SourceContext, commands: Commands, config: WechatCliConfig, cursorKey: string, line: string): Promise<void> {
  if (line.length > 1_048_576) throw new Error('WeChat event exceeds 1 MiB')
  const raw: unknown = JSON.parse(line)
  const failure = z.looseObject({ error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional() })
    .safeParse(raw)
  if (failure.success && failure.data.error) {
    const code = failure.data.error.code ?? 'stream_failed'
    if (code === 'event_cursor_expired') {
      ctx.state.set(cursorKey, await eventCursor(commands, config))
      throw new CursorExpired()
    }
    throw new Error(`WeChat event stream failed: ${failure.data.error.message ?? code}`)
  }
  const event = EventSchema.parse(raw)
  // The daemon's other events (thread, group, send) do not become Triggers; advancing past them is enough.
  if (event.kind !== 'message.committed') { ctx.state.set(cursorKey, event.cursor); return }
  const committed = CommittedSchema.safeParse(event.data)
  if (!committed.success) { ctx.state.set(cursorKey, event.cursor); return }
  const message = await readMessage(commands, config, committed.data.threadId, committed.data.messageId)
    .catch(error => { if (unreadable(error)) return undefined; throw error })
  if (!message) { ctx.state.set(cursorKey, event.cursor); return }
  const trigger = wechatTrigger(message, event.createdAt)
  if (!trigger) { ctx.state.set(cursorKey, event.cursor); return }
  await receive(ctx, trigger)
  ctx.state.set(cursorKey, event.cursor)
}
/** Pieces the heartbeat reads and waits through; tests substitute them to drive the schedule without real waits. */
export interface WechatHeartbeatOptions {
  interval?: number
  retries?: readonly number[]
  now?: () => number
  status?: (commands: Commands, config: WechatCliConfig) => Promise<WechatAccountStatus>
  login?: (commands: Commands, config: WechatCliConfig) => Promise<void>
  pause?: (ms: number, signal: AbortSignal) => Promise<void>
}
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)
/**
 * Watches the account's login state while the message watcher runs. WeChat can end the session without the watch
 * process exiting, so a periodic `auth status` turns that silent outage into a health error. A saved login is retried
 * with exponential backoff, one attempt at a time, and asks for the phone confirmation WeChat needs. The cursor is not
 * touched here: a reconnect resumes from the same position, and the Engine's deterministic Trigger IDs drop replays.
 */
export async function heartbeat(ctx: SourceContext, config: WechatCliConfig, signal: AbortSignal,
  options: WechatHeartbeatOptions = {}): Promise<void> {
  const status = options.status ?? accountStatus
  const login = options.login ?? loginAccount
  const wait = options.pause ?? pause
  const now = options.now ?? Date.now
  const interval = options.interval ?? WECHAT_HEARTBEAT_MS
  const retries = options.retries ?? WECHAT_RECONNECT_MS
  const commands = ctx.commands.withSignal(signal)
  let offline = false
  let nextAttempt = -1
  let step = 0
  let failure = ''
  const report = (state: 'ready' | 'error', detail: string): void => {
    ctx.report(SOURCE, { state, detail, at: new Date().toISOString() })
  }
  const state = (value: WechatAccountStatus): string =>
    `WeChat account ${value.account} is not online (authenticated: ${value.authenticated}, connection: ${value.connection})`
  // The fix is always a person: WeChat's saved login pushes its confirmation to the account's phone.
  const fix = (): string => {
    const hint = 'Confirm the login on the account\'s phone when WeChat asks; if the phone shows nothing, run wx auth login on the daemon host.'
    return failure ? ` The last attempt failed: ${failure}. ${hint}` : ` ${hint}`
  }
  while (!signal.aborted) {
    let value: WechatAccountStatus
    try { value = await status(commands, config) }
    catch (error) {
      if (signal.aborted) return
      offline = true
      report('error', `Cannot read the WeChat account status: ${said(error)}. Check that the Agent WeChat daemon is running; if WeChat signed the account out, confirm the login on the account's phone.`)
      await wait(interval, signal)
      continue
    }
    if (value.online) {
      if (offline) report('ready', 'Listening for WeChat messages')
      offline = false
      nextAttempt = -1
      step = 0
      failure = ''
      await wait(interval, signal)
      continue
    }
    offline = true
    if (nextAttempt < 0 || now() >= nextAttempt) {
      report('error', `${state(value)}. Reconnecting with the saved login.${fix()}`)
      try { await login(commands, config) }
      catch (error) {
        if (signal.aborted) return
        failure = said(error)
      }
      nextAttempt = now() + retries[step]!
      step = Math.min(step + 1, retries.length - 1)
      // Read the state again at once so a login that just succeeded returns the Source to ready without another wait.
      continue
    }
    const remaining = nextAttempt - now()
    report('error', `${state(value)}. Reconnecting in ${Math.max(1, Math.ceil(remaining / 1000))} s.${fix()}`)
    await wait(Math.min(interval, remaining), signal)
  }
}
/** Runs the event consumer while the Source is enabled; disabling it stops the consumer within five seconds. */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let retry: number | undefined
  while (!signal.aborted) {
    // Setup may still be running and the CLI may be chosen later; both are read again on every round.
    const config = enabled(ctx)
    if (!config) {
      ctx.report(SOURCE, health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    if (!ctx.configured()) {
      ctx.report(SOURCE, health('paused', 'setupPending'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    if (!config.cli) {
      ctx.report(SOURCE, health('paused', 'wechatCliUnset'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    // Turning the Source off stops its consumer within five seconds, like the Feishu event consumer.
    const running = new AbortController()
    const beating = new AbortController()
    const stopBeat = (): void => { beating.abort() }
    running.signal.addEventListener('abort', stopBeat, { once: true })
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = (): void => { running.abort() }
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    // Report ready before the heartbeat starts so a startup disconnect replaces it with the error, never the reverse.
    ctx.report(SOURCE, { state: 'ready', detail: 'Listening for WeChat messages', at: new Date().toISOString() })
    const monitoring = heartbeat(ctx, config, beating.signal).catch(() => {})
    try { await consume(ctx, config, running.signal) }
    catch (error) {
      if (!running.signal.aborted) {
        ctx.report(SOURCE, error instanceof CursorExpired
          ? { state: 'ready', detail: 'The daemon no longer retains old events; resumed from now', at: new Date().toISOString() }
          : { state: 'error', detail: String(error) })
      }
    } finally {
      clearInterval(check)
      signal.removeEventListener('abort', stop)
      running.signal.removeEventListener('abort', stopBeat)
      beating.abort()
      await monitoring
    }
    if (signal.aborted) break
    if (!enabled(ctx)) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/**
 * Streams committed messages after the retained cursor and gives each one to the Engine before moving the cursor.
 * An interrupted round keeps the cursor, so a restart replays the events it had not finished; deterministic Trigger
 * IDs make that replay safe.
 */
export async function consume(ctx: SourceContext, config: WechatConfig, signal: AbortSignal): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const cursorKey = KV.wechat.cursor(config.account || 'default')
  let cursor = ctx.state.get(cursorKey)
  if (cursor === undefined) {
    // A first run starts at the daemon's current position instead of replaying every event it still holds.
    cursor = await eventCursor(commands, config)
    ctx.state.set(cursorKey, cursor)
  }
  const child = spawn(config.cli, wechatArgs(config, 'messages', 'watch', '--after', cursor), { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env } })
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve()
  let fatal: unknown
  let diagnostic = ''
  const stop = (): void => { child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  stderr.on('line', (line: string) => { diagnostic = line.slice(0, 4000) })
  stdout.on('line', (line: string) => {
    chain = chain.then(() => applyEvent(ctx, commands, config, cursorKey, line))
      .catch((error: unknown) => { fatal ??= error; child.kill('SIGTERM') })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (signal.aborted) { resolve(); return }
        // The CLI prints its last error as JSON on stderr; an expired cursor must restart from now, not retry forever.
        if (diagnostic.includes('event_cursor_expired')) {
          eventCursor(commands, config).then(cursor => { ctx.state.set(cursorKey, cursor); reject(new CursorExpired()) }, reject)
          return
        }
        reject(fatal ?? new Error(`WeChat event watcher exited (${code ?? 'signal'}): ${diagnostic}`))
      })
    })
  } finally {
    signal.removeEventListener('abort', stop)
    stdout.close()
    stderr.close()
    await chain
  }
}
/** Keeps chat names current so Settings can offer them and Threads show a name instead of an opaque ID. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    if (ctx.configured() && enabled(ctx)?.cli) {
      try { await refreshWechatLabels(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(300_000, undefined, { signal }).catch(() => {})
  }
}
export { CursorExpired }
