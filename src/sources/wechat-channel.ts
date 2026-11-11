/** WeChat outbound channel: sends text through the Agent WeChat CLI under a stable idempotency key. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** The client fields a Channel needs; the Source's saved configuration supplies the CLI and account. */
export interface WechatSendConfig { cli: string; account: string }
/**
 * Sends one text message. The outgoing message ID is the CLI's idempotency key, so an Outbox retry returns the
 * original send instead of posting twice. A send the daemon reports as failed (`needs_review` is not failure) is
 * stopped for that target: retrying unchanged text cannot make WeChat accept it.
 */
export async function sendWechat(host: Pick<SourceContext, 'commands'>, message: OutboundMessage,
  config: WechatSendConfig): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing WeChat reply target')
  if (!config.cli) throw new Error('The WeChat Source has no CLI')
  const args = [...config.account ? ['--account', config.account] : [],
    'messages', 'send', chatId, '--text', message.text, '--idempotency-key', message.id]
  try {
    await host.commands.run(config.cli, ['--json', ...args])
  } catch (error) {
    // Exit 9 is WeChat's refusal (`failed`); retrying the same content with the same key cannot succeed.
    if (error instanceof CliError && error.exitCode === 9) return 'gone'
    throw error
  }
  return 'sent'
}
/** WeChat has no stable web link to a personal chat or message; the panel shows the chat by name only. */
export const wechatLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: '', label: { zh: `微信会话 ${address.chatId ?? ''}`, en: `WeChat chat ${address.chatId ?? ''}` },
})
