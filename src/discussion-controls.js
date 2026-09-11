import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';

// Explicit voice actions have delivery receipts independent of transcript mirroring.
export class DiscussionControls {
  constructor({ conn, client, userId, guildId, target, stateFile, log = () => {} }) {
    Object.assign(this, { conn, client, userId, guildId, target, stateFile, log });
    this.approvals = new Map(); this.posts = null; this.tail = Promise.resolve();
    conn.on('task.approval.requested', e => this.queue(() => this.present(e)));
    conn.on('task.approval.resolved', e => this.queue(() => this.resolve(e)));
    conn.on('discussion.post.requested', e => this.queue(() => this.post(e)));
  }
  queue(fn) { const op = this.tail.then(fn); this.tail = op.catch(() => this.log('Discussion control failed')); return op; }
  key(e) { return createHash('sha256').update(`${e.taskId}:${e.approvalRequestId}`).digest('hex').slice(0, 20); }
  async present(event) {
    const key = this.key(event), old = this.approvals.get(key);
    if (old) { old.event = event; return; }
    const channel = await this.client.channels.fetch(this.target());
    if (!channel?.send || channel.guildId !== this.guildId) throw new Error('Approval destination unavailable');
    const labels = { once: 'Approve once', session: 'Allow this run', always: 'Always allow', deny: 'Deny' };
    const components = [new ActionRowBuilder().addComponents(event.choices.map(choice => new ButtonBuilder()
      .setCustomId(`monte-approval:${key}:${choice}`).setLabel(labels[choice]).setStyle(choice === 'deny' ? ButtonStyle.Danger : ButtonStyle.Secondary)))];
    const command = event.command.replace(/```/g, '` ` `');
    const message = await channel.send({ content: `Hermes needs command approval.\n${event.description.slice(0, 250)}\n\`\`\`\n${command.slice(0, 1200)}\n\`\`\`${command.length > 1200 ? '\nFull command attached.' : ''}`,
      ...(command.length > 1200 ? { files: [{ attachment: Buffer.from(event.command), name: 'pending-command.txt' }] } : {}),
      components, allowedMentions: { parse: [] } });
    this.approvals.set(key, { event, message, responding: false });
  }
  async resolve(event) {
    const key = this.key(event), entry = this.approvals.get(key);
    if (!entry) return;
    await entry.message.edit({ content: `Command approval ${event.state}${event.choice ? `: ${event.choice}` : ''}.`, components: [], attachments: [], allowedMentions: { parse: [] } });
    this.approvals.delete(key);
  }
  async interaction(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('monte-approval:')) return false;
    if (interaction.user.id !== this.userId || interaction.guildId !== this.guildId) {
      await interaction.reply({ content: 'This approval belongs to the voice session owner.', flags: MessageFlags.Ephemeral }); return true;
    }
    const [, key, choice] = interaction.customId.split(':');
    const entry = this.approvals.get(key);
    if (!entry || entry.responding || !entry.event.choices.includes(choice) || interaction.message.id !== entry.message.id) {
      await interaction.reply({ content: 'That approval is no longer actionable. Use the current prompt.', flags: MessageFlags.Ephemeral }); return true;
    }
    entry.responding = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const e = entry.event;
      await this.conn.respondApproval(e.taskId, e.runId, e.approvalRequestId, choice);
      await interaction.editReply(`Hermes confirmed: ${choice}.`);
    } catch (error) { await interaction.editReply(error.message.slice(0, 1500)); }
    return true;
  }
  async loadPosts() {
    if (this.posts) return;
    try { const value = JSON.parse(await readFile(this.stateFile, 'utf8')); if (value.version !== 1 || !value.posts) throw new Error('Invalid post receipts'); this.posts = value.posts; }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.posts = {}; }
  }
  async savePosts() {
    const entries = Object.entries(this.posts);
    if (entries.length > 1000) this.posts = Object.fromEntries(entries.slice(-1000));
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, posts: this.posts }), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.stateFile);
  }
  async post(event) {
    const report = result => this.conn.reportPostResult(event.receipt, result);
    const origin = event.origin;
    if (origin.userId !== this.userId || origin.guildId !== this.guildId) { report({ ok: false, error: 'Discussion origin does not match this bridge.' }); return; }
    await this.loadPosts();
    const fingerprint = createHash('sha256').update(JSON.stringify([origin, event.text])).digest('hex');
    const previous = this.posts[event.receipt];
    if (previous) {
      report(previous.fingerprint === fingerprint ? previous.result ?? { ok: false, error: 'An earlier delivery was interrupted. Check the thread before retrying.' } : { ok: false, error: 'Receipt was reused with different content.' }); return;
    }
    const channel = await this.client.channels.fetch(origin.threadId ?? origin.channelId);
    if (!channel?.send || channel.guildId !== this.guildId) { report({ ok: false, error: 'Discussion destination is unavailable.' }); return; }
    this.posts[event.receipt] = { fingerprint }; await this.savePosts();
    let result;
    try {
      let message;
      for (let i = 0; i < event.text.length; i += 1900) {
        const nonce = createHash('sha256').update(`${event.receipt}:${i}`).digest('hex').slice(0, 24);
        message = await channel.send({ content: event.text.slice(i, i + 1900), allowedMentions: { parse: [] }, nonce, enforceNonce: true });
      }
      result = { ok: true, messageId: message.id };
    } catch { result = { ok: false, error: 'Delivery could not be confirmed. Check the thread before retrying.' }; }
    this.posts[event.receipt].result = result; await this.savePosts(); report(result);
  }
}
