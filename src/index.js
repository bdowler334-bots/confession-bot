require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DATA_FILE = path.join(DATA_DIR, 'confessions.json');
const BRAND_IMAGE = path.join(__dirname, '..', 'assets', 'rainbow-pineapple.png');
const BRAND_FILENAME = 'rainbow-pineapple.png';
const brandAttachment = () => new AttachmentBuilder(BRAND_IMAGE, { name: BRAND_FILENAME });
const PRIVACY_NOTICE = '**Privacy:** Anonymous to members.';
const defaultMemberMessages = () => ({
  formLabel: 'Your confession',
  formPlaceholder: 'Your name will not be shown .',
  pending: '✅ Confession #{id} was submitted for staff approval.',
  posted: '✅ Confession #{id} was posted anonymously.',
});

function confirmationText(settings, stage, id) {
  const template = settings.memberMessages?.[stage] || defaultMemberMessages()[stage];
  return `${template.replaceAll('{id}', String(id))}\n\n${PRIVACY_NOTICE}`;
}

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultSettings = () => ({
  confessionChannelId: null,
  verifiedRoleId: null,
  logChannelId: null,
  errorLogChannelId: null,
  reviewChannelId: null,
  approvalRequired: true,
  cooldownSeconds: 60,
  allowAttachments: true,
  allowReplies: true,
  allowReactions: true,
  color: 0xF4C430,
  title: '🍍 Pineapple Confession',
  footer: 'Welcome to Anonymous confessions',
  memberMessages: defaultMemberMessages(),
  blockedUsers: [],
  blockedWords: [],
});

let db = { guilds: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Could not parse data file. Refusing to overwrite it:', err);
    process.exit(1);
  }
}

let saveQueue = Promise.resolve();
function saveDb() {
  saveQueue = saveQueue.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(err => {
    console.error('Database save failed:', err);
    void broadcastError(err, 'Database save');
  });
  return saveQueue;
}

function getGuildData(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      settings: defaultSettings(),
      counter: 0,
      confessions: {},
      cooldowns: {},
    };
  }
  const g = db.guilds[guildId];
  g.settings = { ...defaultSettings(), ...(g.settings || {}) };
  g.settings.memberMessages = { ...defaultMemberMessages(), ...(g.settings.memberMessages || {}) };
  g.confessions ||= {};
  g.cooldowns ||= {};
  g.counter ||= 0;
  return g;
}

function isAdmin(interaction) {
  if (!interaction.guild) return false;
  if (interaction.user.id === interaction.guild.ownerId) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

async function isVerified(interaction, settings) {
  if (isAdmin(interaction)) return true;
  if (!settings.verifiedRoleId) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(member?.roles.cache.has(settings.verifiedRoleId));
}

function isBlocked(guildData, userId) {
  return guildData.settings.blockedUsers.includes(userId);
}

function blockedWord(guildData, text) {
  const lower = text.toLowerCase();
  return guildData.settings.blockedWords.find(w => lower.includes(w.toLowerCase())) || null;
}

function formatDiscordTime(iso) {
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${ts}:F> • <t:${ts}:R>`;
}

function confessionEmbed(guildData, record) {
  return new EmbedBuilder()
    .setColor(guildData.settings.color)
    .setTitle(`${guildData.settings.title} #${record.id}`)
    .setDescription(record.text || '*No text provided.*')
    .setImage('attachment://' + BRAND_FILENAME)
    .setFooter({ text: guildData.settings.footer })
    .setTimestamp(new Date(record.createdAt));
}

function replyEmbed(guildData, confessionId, text) {
  return new EmbedBuilder()
    .setColor(guildData.settings.color)
    .setTitle(`↪ Anonymous reply to Confession #${confessionId}`)
    .setDescription(text)
    .setFooter({ text: guildData.settings.footer })
    .setTimestamp();
}

function publicButtons(guildData, confessionId) {
  const buttons = [];
  if (guildData.settings.allowReplies) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`reply:${confessionId}`)
        .setLabel('Anonymous Reply')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`report:${confessionId}`)
      .setLabel('Report')
      .setEmoji('🚩')
      .setStyle(ButtonStyle.Danger)
  );
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

async function sendLog(guild, title, description, fields = []) {
  const gd = getGuildData(guild.id);
  const channelId = gd.settings.logChannelId;
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
  if (!channel?.isTextBased() || !isRestricted(channel, guild, null)) return false;

  const embed = new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(title)
    .setDescription(description || null)
    .addFields(fields)
    .setTimestamp();

  return channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true).catch(err => {
    console.error(`Failed to write confession log in guild ${guild.id}:`, err);
    void sendErrorLog(guild, err, 'Author log delivery');
    return false;
  });
}

function makeErrorId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function sendErrorLog(guild, err, context, errorId = makeErrorId(), userId = null) {
  if (!guild) return false;
  const channelId = getGuildData(guild.id).settings.errorLogChannelId;
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
  if (!channel?.isTextBased() || !isRestricted(channel, guild, null)) {
    console.error(`Error-log channel in guild ${guild.id} is missing or not private.`);
    return false;
  }
  const detail = String(err?.stack || err || 'Unknown error').replaceAll(TOKEN, '[REDACTED]').slice(0, 3500);
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(`🚨 Confessions bot error • ${errorId}`)
    .setDescription(detail)
    .addFields(
      { name: 'Context', value: String(context || 'Unknown').slice(0, 1024) },
      { name: 'User ID', value: userId || 'Not available' }
    )
    .setTimestamp();
  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (deliveryError) {
    console.error(`Failed to send error log in guild ${guild.id}:`, deliveryError);
    return false;
  }
}

async function broadcastError(err, context) {
  const guilds = [...client.guilds.cache.values()];
  const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : (guilds.length === 1 ? guilds[0] : null);
  if (guild) await sendErrorLog(guild, err, context);
}

function isRestricted(channel, guild, verifiedRoleId) {
  const cache = channel?.permissionOverwrites?.cache;
  if (!cache?.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel)) return false;
  if (verifiedRoleId && !cache.get(verifiedRoleId)?.allow.has(PermissionFlagsBits.ViewChannel)) return false;
  return cache.every(o => [guild.ownerId, guild.members.me?.id, verifiedRoleId].includes(o.id) ||
    !o.allow.has(PermissionFlagsBits.ViewChannel));
}

async function restrictChannel(channel, guild, verifiedRoleId = null) {
  const me = guild.members.me || await guild.members.fetchMe();
  await channel.permissionOverwrites.set([
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(verifiedRoleId ? [{ id: verifiedRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : []),
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] },
  ], 'Secure Pineapple Confessions');
  const fresh = await guild.channels.fetch(channel.id, { force: true });
  if (!isRestricted(fresh, guild, verifiedRoleId)) throw new Error('Channel permissions could not be verified.');
}

async function lockPrivateChannel(channel, guild, label) {
  if (!channel || !('permissionOverwrites' in channel)) {
    return { ok: false, note: `${label} is not a configurable guild channel.` };
  }
  try {
    await restrictChannel(channel, guild);
    return {
      ok: true,
      note: `${label} is Owner/Admin only. Existing channel-specific grants were removed.`,
    };
  } catch (err) {
    return {
      ok: false,
      note: `I could not automatically lock ${label}. Give the bot Manage Channels, then run /confessions setup again. (${err.message})`,
    };
  }
}

function cooldownRemaining(guildData, userId) {
  const last = Number(guildData.cooldowns[userId] || 0);
  const waitMs = guildData.settings.cooldownSeconds * 1000;
  return Math.max(0, last + waitMs - Date.now());
}

async function postConfession(guild, gd, record) {
  const channel = await guild.channels.fetch(gd.settings.confessionChannelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('Configured confession channel is missing or not text based.');

  const files = [brandAttachment()];
  if (record.attachmentUrl) {
    files.push(new AttachmentBuilder(record.attachmentUrl));
  }

  const message = await channel.send({
    embeds: [confessionEmbed(gd, record)],
    components: publicButtons(gd, record.id),
    files,
  });

  record.publicMessageId = message.id;
  record.publicChannelId = channel.id;
  record.status = 'posted';
  record.postedAt = new Date().toISOString();

  if (gd.settings.allowReactions) {
    for (const emoji of ['❤️', '😂', '👀']) {
      await message.react(emoji).catch(() => {});
    }
  }
  await saveDb();
  return message;
}

async function queueForApproval(guild, gd, record) {
  const channelId = gd.settings.reviewChannelId || gd.settings.logChannelId;
  const channel = channelId ? await guild.channels.fetch(channelId, { force: true }).catch(() => null) : null;
  if (!channel?.isTextBased() || !isRestricted(channel, guild, null)) {
    throw new Error('Approval mode is enabled, but no valid review/log channel is configured.');
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve:${record.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${record.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`inspect:${record.id}`).setLabel('View Submitter').setStyle(ButtonStyle.Secondary),
  );

  const embed = confessionEmbed(gd, record)
    .setTitle(`Pending Confession #${record.id}`)
    .addFields(
      { name: 'Submitter', value: `<@${record.authorId}> (\`${record.authorId}\`)` },
      { name: 'Submitted', value: formatDiscordTime(record.createdAt) }
    );

  const files = [brandAttachment()];
  if (record.attachmentUrl) files.push(new AttachmentBuilder(record.attachmentUrl));
  const msg = await channel.send({ embeds: [embed], components: [row], files });
  record.reviewMessageId = msg.id;
  record.reviewChannelId = channel.id;
  record.status = 'pending';
  await saveDb();
}

async function submitConfession(interaction, text, attachmentUrl = null) {
  const gd = getGuildData(interaction.guildId);
  const s = gd.settings;

  if (!s.confessionChannelId || !s.logChannelId || !s.verifiedRoleId) {
    return interaction.reply({
      ephemeral: true,
      content: 'Confessions are not configured yet. An Administrator must run `/confessions setup` first.',
    });
  }

  if (!await isVerified(interaction, s)) {
    return interaction.reply({ ephemeral: true, content: 'Verified role required to submit confessions.' });
  }

  if (isBlocked(gd, interaction.user.id)) {
    return interaction.reply({
      ephemeral: true,
      content: 'You are not permitted to submit confessions in this server.',
    });
  }

  const remaining = cooldownRemaining(gd, interaction.user.id);
  if (remaining > 0) {
    return interaction.reply({
      ephemeral: true,
      content: `Please wait ${Math.ceil(remaining / 1000)} seconds before submitting another confession.`,
    });
  }

  const bad = blockedWord(gd, text);
  if (bad) {
    return interaction.reply({
      ephemeral: true,
      content: 'Your confession contains a word or phrase blocked by this server.',
    });
  }

  if (attachmentUrl && !s.allowAttachments) {
    return interaction.reply({ ephemeral: true, content: 'Attachments are disabled for confessions in this server.' });
  }

  const publicChannel = await interaction.guild.channels.fetch(s.confessionChannelId, { force: true }).catch(() => null);
  const logChannel = await interaction.guild.channels.fetch(s.logChannelId, { force: true }).catch(() => null);
  const reviewChannel = s.approvalRequired
    ? await interaction.guild.channels.fetch(s.reviewChannelId || s.logChannelId, { force: true }).catch(() => null) : null;
  if (!isRestricted(publicChannel, interaction.guild, s.verifiedRoleId) ||
      !isRestricted(logChannel, interaction.guild, null) ||
      (s.approvalRequired && !isRestricted(reviewChannel, interaction.guild, null))) {
    void sendErrorLog(interaction.guild, new Error('Confession, author-log, or review-channel permissions could not be verified.'),
      'Submission permission check', makeErrorId(), interaction.user.id);
    return interaction.reply({ ephemeral: true, content: 'Channel permissions need repair. Ask an Administrator to rerun setup.' });
  }

  gd.counter += 1;
  const id = gd.counter;
  const now = new Date().toISOString();

  const record = {
    id,
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    text,
    attachmentUrl,
    createdAt: now,
    status: 'created',
    publicMessageId: null,
    publicChannelId: null,
    reviewMessageId: null,
    reviewChannelId: null,
    reports: [],
    replies: [],
    history: [{ action: 'submitted', at: now, by: interaction.user.id }],
  };

  gd.confessions[String(id)] = record;
  gd.cooldowns[interaction.user.id] = Date.now();
  await saveDb();

  const logged = await sendLog(
    interaction.guild,
    `🧾 Confession #${id} submitted`,
    `A new confession was submitted by <@${interaction.user.id}>.`,
    [
      { name: 'User', value: `${interaction.user.tag}\n\`${interaction.user.id}\`` },
      { name: 'Content', value: text.slice(0, 1024) || '*No text*' },
      { name: 'Attachment', value: attachmentUrl || 'None' },
      { name: 'Submitted', value: formatDiscordTime(now) },
    ]
  );
  if (!logged) {
    record.status = 'error';
    await saveDb();
    return interaction.reply({ ephemeral: true, content: 'Could not write the private author log, so nothing was posted.' });
  }

  try {
    if (s.approvalRequired) {
      await queueForApproval(interaction.guild, gd, record);
      return interaction.reply({
        ephemeral: true,
        content: confirmationText(s, 'pending', id),
        allowedMentions: { parse: [] },
      });
    }

    await postConfession(interaction.guild, gd, record);
    return interaction.reply({
      ephemeral: true,
      content: confirmationText(s, 'posted', id),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    const errorId = makeErrorId();
    record.status = 'error';
    record.history.push({ action: 'post_error', at: new Date().toISOString(), error: err.message });
    await saveDb();
    void sendErrorLog(interaction.guild, err, `Confession #${id} posting/review`, errorId, interaction.user.id);
    return interaction.reply({
      ephemeral: true,
      content: `Confession #${id} was saved but could not be posted (error ID: ${errorId}). Please tell a Server Owner or Admin.`,
    });
  }
}

async function fetchPublicMessage(guild, record) {
  if (!record.publicChannelId || !record.publicMessageId) return null;
  const channel = await guild.channels.fetch(record.publicChannelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(record.publicMessageId).catch(() => null);
}

const commands = [
  new SlashCommandBuilder()
    .setName('confess')
    .setDescription('Submit an anonymous confession using a private form.')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('confess-file')
    .setDescription('Submit an anonymous confession with an attachment.')
    .setContexts(InteractionContextType.Guild)
    .addAttachmentOption(o => o.setName('attachment').setDescription('Image/file to attach').setRequired(true))
    .addStringOption(o => o.setName('caption').setDescription('Confession text or caption').setMaxLength(1900).setRequired(true)),

  new SlashCommandBuilder()
    .setName('confession')
    .setDescription('Manage your anonymous confessions.')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(s => s.setName('mine').setDescription('Privately list your recent confession IDs.'))
    .addSubcommand(s => s.setName('delete').setDescription('Delete one of your confessions.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit one of your posted confessions.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('text').setDescription('New confession text').setMaxLength(2000).setRequired(true)))
    .addSubcommand(s => s.setName('reply').setDescription('Post an anonymous reply to a confession.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('text').setDescription('Anonymous reply').setMaxLength(1800).setRequired(true)))
    .addSubcommand(s => s.setName('report').setDescription('Privately report a confession to admins.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for report').setMaxLength(1000).setRequired(true))),

  new SlashCommandBuilder()
    .setName('confessions')
    .setDescription('Administrator controls for the confession system.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('setup').setDescription('Configure confession and private log channels.')
      .addChannelOption(o => o.setName('confession_channel').setDescription('Public confession channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption(o => o.setName('log_channel').setDescription('Private Owner/Admin audit log').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('verified_role').setDescription('Role permitted to see public confessions').setRequired(true))
      .addChannelOption(o => o.setName('review_channel').setDescription('Optional private approval queue').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('error-log').setDescription('Set an Owner/Admin-only channel for bot error reports.')
      .addChannelOption(o => o.setName('channel').setDescription('Private error-log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('settings').setDescription('Show current confession settings.'))
    .addSubcommand(s => s.setName('form').setDescription('Customize the confession form prompt (privacy title stays fixed).')
      .addStringOption(o => o.setName('label').setDescription('Prompt above the text box, up to 45 characters').setMaxLength(45).setRequired(true))
      .addStringOption(o => o.setName('placeholder').setDescription('Hint inside the text box, up to 100 characters').setMaxLength(100).setRequired(true)))
    .addSubcommand(s => s.setName('confirmation').setDescription('Customize the private reply after submission.')
      .addStringOption(o => o.setName('stage').setDescription('Approval queue or immediately posted').setRequired(true)
        .addChoices({ name: 'Pending approval', value: 'pending' }, { name: 'Posted', value: 'posted' }))
      .addStringOption(o => o.setName('text').setDescription('Use {id} for the confession number (max 1200 characters)').setMaxLength(1200).setRequired(true)))
    .addSubcommand(s => s.setName('message-preview').setDescription('Privately preview the form prompt and one confirmation message.')
      .addStringOption(o => o.setName('stage').setDescription('Which confirmation to preview').setRequired(true)
        .addChoices({ name: 'Pending approval', value: 'pending' }, { name: 'Posted', value: 'posted' })))
    .addSubcommand(s => s.setName('message-reset').setDescription('Restore default form prompt and confirmation messages.'))
    .addSubcommand(s => s.setName('approval').setDescription('Require staff approval before confessions are posted.')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable approval mode').setRequired(true)))
    .addSubcommand(s => s.setName('cooldown').setDescription('Set confession cooldown in seconds.')
      .addIntegerOption(o => o.setName('seconds').setDescription('0-86400').setMinValue(0).setMaxValue(86400).setRequired(true)))
    .addSubcommand(s => s.setName('attachments').setDescription('Allow or deny confession attachments.')
      .addBooleanOption(o => o.setName('enabled').setDescription('Allow attachments').setRequired(true)))
    .addSubcommand(s => s.setName('replies').setDescription('Allow or deny anonymous replies.')
      .addBooleanOption(o => o.setName('enabled').setDescription('Allow replies').setRequired(true)))
    .addSubcommand(s => s.setName('reactions').setDescription('Add default reactions to new confessions.')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable reactions').setRequired(true)))
    .addSubcommand(s => s.setName('block').setDescription('Block a member from submitting confessions.')
      .addUserOption(o => o.setName('user').setDescription('Member to block').setRequired(true)))
    .addSubcommand(s => s.setName('unblock').setDescription('Remove a member from the confession block list.')
      .addUserOption(o => o.setName('user').setDescription('Member to unblock').setRequired(true)))
    .addSubcommand(s => s.setName('filter-add').setDescription('Add a blocked word or phrase.')
      .addStringOption(o => o.setName('phrase').setDescription('Word or phrase').setMaxLength(100).setRequired(true)))
    .addSubcommand(s => s.setName('filter-remove').setDescription('Remove a blocked word or phrase.')
      .addStringOption(o => o.setName('phrase').setDescription('Word or phrase').setMaxLength(100).setRequired(true)))
    .addSubcommand(s => s.setName('inspect').setDescription('Reveal the submitter of a confession to Owner/Admin.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('approve').setDescription('Approve a pending confession.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('reject').setDescription('Reject a pending confession.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Optional rejection reason').setMaxLength(500)))
    .addSubcommand(s => s.setName('hide').setDescription('Remove a posted confession while preserving its audit record.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('restore').setDescription('Repost a hidden confession.')
      .addIntegerOption(o => o.setName('id').setDescription('Confession number').setMinValue(1).setRequired(true))),
].map(c => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} command groups in guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`Registered ${commands.length} global command groups.`);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, readyClient => {
  console.log(`Pineapple Confessions online as ${readyClient.user.tag}`);
});

client.on(Events.Error, err => {
  console.error('Discord client error:', err);
  void broadcastError(err, 'Discord client');
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
  void broadcastError(err, 'Unhandled rejection');
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
      const gd = getGuildData(interaction.guildId);

      if (interaction.commandName === 'confess') {
        if (!gd.settings.confessionChannelId || !gd.settings.logChannelId || !gd.settings.verifiedRoleId) {
          return interaction.reply({ ephemeral: true, content: 'Confessions are not configured yet. An Administrator must run `/confessions setup`.' });
        }
        if (isBlocked(gd, interaction.user.id)) {
          return interaction.reply({ ephemeral: true, content: 'You are not permitted to submit confessions in this server.' });
        }
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        const remaining = cooldownRemaining(gd, interaction.user.id);
        if (remaining > 0) {
          return interaction.reply({ ephemeral: true, content: `Please wait ${Math.ceil(remaining / 1000)} seconds before submitting another confession.` });
        }

        const modal = new ModalBuilder()
          .setCustomId('confess-modal')
          .setTitle('Confession • Anonymous mode enabled');

        const text = new TextInputBuilder()
          .setCustomId('text')
          .setLabel(gd.settings.memberMessages.formLabel)
          .setPlaceholder(gd.settings.memberMessages.formPlaceholder)
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(1)
          .setMaxLength(2000)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(text));
        return interaction.showModal(modal);
      }

      if (interaction.commandName === 'confess-file') {
        const attachment = interaction.options.getAttachment('attachment', true);
        const caption = interaction.options.getString('caption', true);
        return submitConfession(interaction, caption, attachment.url);
      }

      if (interaction.commandName === 'confession') {
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        const sub = interaction.options.getSubcommand();

        if (sub === 'mine') {
          const mine = Object.values(gd.confessions)
            .filter(c => c.authorId === interaction.user.id)
            .sort((a, b) => b.id - a.id)
            .slice(0, 10);

          if (!mine.length) return interaction.reply({ ephemeral: true, content: 'You have no saved confessions in this server.' });
          const lines = mine.map(c => `#${c.id} — **${c.status}** — ${formatDiscordTime(c.createdAt)}`);
          return interaction.reply({ ephemeral: true, content: `Your recent confessions:\n${lines.join('\n')}` });
        }

        const id = interaction.options.getInteger('id', true);
        const record = gd.confessions[String(id)];
        if (!record) return interaction.reply({ ephemeral: true, content: `Confession #${id} does not exist.` });

        if (sub === 'delete') {
          if (record.authorId !== interaction.user.id) {
            return interaction.reply({ ephemeral: true, content: 'You can only delete your own confession.' });
          }
          const msg = await fetchPublicMessage(interaction.guild, record);
          if (msg) await msg.delete().catch(() => {});
          record.status = 'deleted_by_author';
          record.history.push({ action: 'deleted_by_author', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await sendLog(interaction.guild, `🗑️ Confession #${id} deleted by submitter`, `The original submitter <@${interaction.user.id}> deleted their confession.`);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} was deleted.` });
        }

        if (sub === 'edit') {
          if (record.authorId !== interaction.user.id) {
            return interaction.reply({ ephemeral: true, content: 'You can only edit your own confession.' });
          }
          if (record.status !== 'posted') {
            return interaction.reply({ ephemeral: true, content: 'Only currently posted confessions can be edited.' });
          }
          const newText = interaction.options.getString('text', true);
          const bad = blockedWord(gd, newText);
          if (bad) return interaction.reply({ ephemeral: true, content: 'The edited confession contains a blocked word or phrase.' });

          record.text = newText;
          record.editedAt = new Date().toISOString();
          record.history.push({ action: 'edited_by_author', at: record.editedAt, by: interaction.user.id });
          const msg = await fetchPublicMessage(interaction.guild, record);
          if (msg) {
            const update = { embeds: [confessionEmbed(gd, record)], components: publicButtons(gd, id) };
            if (!msg.attachments.some(a => a.name === BRAND_FILENAME)) update.files = [brandAttachment()];
            await msg.edit(update);
          }
          await saveDb();
          await sendLog(interaction.guild, `✏️ Confession #${id} edited`, `Submitter: <@${interaction.user.id}>`, [
            { name: 'Updated content', value: newText.slice(0, 1024) }
          ]);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} was updated.` });
        }

        if (sub === 'reply') {
          if (!gd.settings.allowReplies) return interaction.reply({ ephemeral: true, content: 'Anonymous replies are disabled.' });
          if (record.status !== 'posted') return interaction.reply({ ephemeral: true, content: 'That confession is not currently posted.' });
          const text = interaction.options.getString('text', true);
          const bad = blockedWord(gd, text);
          if (bad) return interaction.reply({ ephemeral: true, content: 'Your reply contains a blocked word or phrase.' });

          const channel = await interaction.guild.channels.fetch(record.publicChannelId).catch(() => null);
          if (!channel?.isTextBased()) return interaction.reply({ ephemeral: true, content: 'The confession channel could not be found.' });
          const msg = await channel.send({ embeds: [replyEmbed(gd, id, text)] });
          const reply = {
            id: record.replies.length + 1,
            authorId: interaction.user.id,
            authorTag: interaction.user.tag,
            text,
            createdAt: new Date().toISOString(),
            publicMessageId: msg.id,
          };
          record.replies.push(reply);
          await saveDb();
          await sendLog(interaction.guild, `↩️ Anonymous reply to Confession #${id}`, `Reply by <@${interaction.user.id}> (\`${interaction.user.id}\`)`, [
            { name: 'Reply', value: text.slice(0, 1024) }
          ]);
          return interaction.reply({ ephemeral: true, content: 'Your anonymous reply was posted.});
        }

        if (sub === 'report') {
          const reason = interaction.options.getString('reason', true);
          const report = {
            reporterId: interaction.user.id,
            reporterTag: interaction.user.tag,
            reason,
            at: new Date().toISOString(),
          };
          record.reports.push(report);
          await saveDb();
          await sendLog(interaction.guild, `🚩 Confession #${id} reported`, `Reported by <@${interaction.user.id}> (\`${interaction.user.id}\`)`, [
            { name: 'Reason', value: reason.slice(0, 1024) },
            { name: 'Original submitter', value: `<@${record.authorId}> (\`${record.authorId}\`)` },
          ]);
          return interaction.reply({ ephemeral: true, content: `Report sent privately for Confession #${id}.` });
        }
      }

      if (interaction.commandName === 'confessions') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ ephemeral: true, content: 'Server Owner or Administrator permission is required.' });
        }

        const sub = interaction.options.getSubcommand();
        const s = gd.settings;

        if (sub === 'error-log') {
          const channel = interaction.options.getChannel('channel', true);
          if (channel.id === s.confessionChannelId) {
            return interaction.reply({ ephemeral: true, content: 'The public confession channel cannot be used for private error logs.' });
          }
          const secured = await lockPrivateChannel(channel, interaction.guild, 'the error-log channel');
          if (!secured.ok) return interaction.reply({ ephemeral: true, content: `Setup stopped: ${secured.note}` });
          try {
            await channel.send({ content: '✅ Pineapple Confessions error logging is active in this private channel.', allowedMentions: { parse: [] } });
          } catch (err) {
            return interaction.reply({ ephemeral: true, content: `Could not send to that channel: ${err.message}` });
          }
          s.errorLogChannelId = channel.id;
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Bot errors will be reported in <#${channel.id}> (Server Owner/Admin only).` });
        }

        if (sub === 'setup') {
          const confessionChannel = interaction.options.getChannel('confession_channel', true);
          const logChannel = interaction.options.getChannel('log_channel', true);
          const verifiedRole = interaction.options.getRole('verified_role', true);
          const reviewChannel = interaction.options.getChannel('review_channel');
          if (verifiedRole.id === interaction.guild.id || verifiedRole.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ ephemeral: true, content: 'Choose a normal Verified role without Administrator permission.' });
          }
          if (confessionChannel.id === logChannel.id || confessionChannel.id === reviewChannel?.id) {
            return interaction.reply({ ephemeral: true, content: 'Public and private channels must be separate.' });
          }

          const logLock = await lockPrivateChannel(logChannel, interaction.guild, 'the confession log channel');
          let reviewLock = null;
          if (reviewChannel && reviewChannel.id !== logChannel.id) reviewLock = await lockPrivateChannel(reviewChannel, interaction.guild, 'the review channel');
          if (!logLock.ok || (reviewLock && !reviewLock.ok)) {
            return interaction.reply({ ephemeral: true, content: `Setup stopped: ${[logLock.note, reviewLock?.note].filter(Boolean).join(' ')}` });
          }
          try { await restrictChannel(confessionChannel, interaction.guild, verifiedRole.id); }
          catch (err) { return interaction.reply({ ephemeral: true, content: `Could not secure the public channel: ${err.message}` }); }
          s.confessionChannelId = confessionChannel.id;
          s.verifiedRoleId = verifiedRole.id;
          s.logChannelId = logChannel.id;
          s.reviewChannelId = reviewChannel?.id || null;
          await saveDb();

          await sendLog(interaction.guild, '⚙️ Confession system configured', `Configured by <@${interaction.user.id}>.`, [
            { name: 'Public channel', value: `<#${confessionChannel.id}>` },
            { name: 'Verified role', value: `<@&${verifiedRole.id}>` },
            { name: 'Private log', value: `<#${logChannel.id}>` },
            { name: 'Review queue', value: reviewChannel ? `<#${reviewChannel.id}>` : 'Uses log channel when approval is enabled' },
          ]);

          const notes = [logLock.note];
          if (reviewLock) notes.push(reviewLock.note);
          return interaction.reply({
            ephemeral: true,
            content: `✅ Confession system configured.\n${notes.map(n => `• ${n}`).join('\n')}`,
          });
        }

        if (sub === 'settings') {
          return interaction.reply({
            ephemeral: true,
            embeds: [
              new EmbedBuilder()
                .setColor(s.color)
                .setTitle('🍍 Pineapple Confessions Settings')
                .addFields(
                  { name: 'Public channel', value: s.confessionChannelId ? `<#${s.confessionChannelId}>` : 'Not set', inline: true },
                  { name: 'Verified role', value: s.verifiedRoleId ? `<@&${s.verifiedRoleId}>` : 'Not set', inline: true },
                  { name: 'Private log', value: s.logChannelId ? `<#${s.logChannelId}>` : 'Not set', inline: true },
                  { name: 'Error log', value: s.errorLogChannelId ? `<#${s.errorLogChannelId}>` : 'Not set', inline: true },
                  { name: 'Review channel', value: s.reviewChannelId ? `<#${s.reviewChannelId}>` : 'Not set', inline: true },
                  { name: 'Approval required', value: String(s.approvalRequired), inline: true },
                  { name: 'Cooldown', value: `${s.cooldownSeconds}s`, inline: true },
                  { name: 'Attachments', value: String(s.allowAttachments), inline: true },
                  { name: 'Anonymous replies', value: String(s.allowReplies), inline: true },
                  { name: 'Default reactions', value: String(s.allowReactions), inline: true },
                  { name: 'Blocked users', value: String(s.blockedUsers.length), inline: true },
                  { name: 'Blocked phrases', value: String(s.blockedWords.length), inline: true },
                  { name: 'Saved confessions', value: String(Object.keys(gd.confessions).length), inline: true },
                )
            ]
          });
        }

        if (sub === 'form') {
          s.memberMessages.formLabel = interaction.options.getString('label', true);
          s.memberMessages.formPlaceholder = interaction.options.getString('placeholder', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: 'The confession form prompt was updated. Use `/confessions message-preview` to see it.' });
        }

        if (sub === 'confirmation') {
          const stage = interaction.options.getString('stage', true);
          s.memberMessages[stage] = interaction.options.getString('text', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `The ${stage} confirmation was updated. The privacy notice is added automatically.` });
        }

        if (sub === 'message-preview') {
          const stage = interaction.options.getString('stage', true);
          return interaction.reply({
            ephemeral: true,
            content: `**Form title:** Confession • Anonymous mode enabled you\n**Form label:** ${s.memberMessages.formLabel}\n**Form hint:** ${s.memberMessages.formPlaceholder}\n\n**${stage === 'pending' ? 'Pending approval' : 'Posted'} confirmation:**\n${confirmationText(s, stage, 123)}`,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === 'message-reset') {
          s.memberMessages = defaultMemberMessages();
          await saveDb();
          return interaction.reply({ ephemeral: true, content: 'The form prompt and submission confirmations were reset to their defaults.' });
        }

        if (sub === 'approval') {
          s.approvalRequired = interaction.options.getBoolean('enabled', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Approval mode is now **${s.approvalRequired ? 'ON' : 'OFF'}**.` });
        }

        if (sub === 'cooldown') {
          s.cooldownSeconds = interaction.options.getInteger('seconds', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Confession cooldown set to **${s.cooldownSeconds} seconds**.` });
        }

        if (sub === 'attachments') {
          s.allowAttachments = interaction.options.getBoolean('enabled', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Attachments are now **${s.allowAttachments ? 'enabled' : 'disabled'}**.` });
        }

        if (sub === 'replies') {
          s.allowReplies = interaction.options.getBoolean('enabled', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Anonymous replies are now **${s.allowReplies ? 'enabled' : 'disabled'}**.` });
        }

        if (sub === 'reactions') {
          s.allowReactions = interaction.options.getBoolean('enabled', true);
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Default confession reactions are now **${s.allowReactions ? 'enabled' : 'disabled'}**.` });
        }

        if (sub === 'block' || sub === 'unblock') {
          const user = interaction.options.getUser('user', true);
          if (sub === 'block') {
            if (!s.blockedUsers.includes(user.id)) s.blockedUsers.push(user.id);
          } else {
            s.blockedUsers = s.blockedUsers.filter(id => id !== user.id);
          }
          await saveDb();
          await sendLog(interaction.guild, `🔒 Confession ${sub}`, `${interaction.user.tag} ${sub === 'block' ? 'blocked' : 'unblocked'} ${user.tag} (\`${user.id}\`).`);
          return interaction.reply({ ephemeral: true, content: `${user.tag} is now ${sub === 'block' ? 'blocked from' : 'allowed to use'} confessions.` });
        }

        if (sub === 'filter-add' || sub === 'filter-remove') {
          const phrase = interaction.options.getString('phrase', true).trim();
          if (sub === 'filter-add') {
            if (!s.blockedWords.some(x => x.toLowerCase() === phrase.toLowerCase())) s.blockedWords.push(phrase);
          } else {
            s.blockedWords = s.blockedWords.filter(x => x.toLowerCase() !== phrase.toLowerCase());
          }
          await saveDb();
          return interaction.reply({ ephemeral: true, content: `Filter updated. There are now ${s.blockedWords.length} blocked words/phrases.` });
        }

        const id = interaction.options.getInteger('id', true);
        const record = gd.confessions[String(id)];
        if (!record) return interaction.reply({ ephemeral: true, content: `Confession #${id} does not exist.` });

        if (sub === 'inspect') {
          record.history.push({ action: 'identity_inspected', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await sendLog(interaction.guild, `👁️ Identity inspected for Confession #${id}`, `<@${interaction.user.id}> inspected the submitter identity.`, [
            { name: 'Submitter', value: `${record.authorTag}\n<@${record.authorId}>\n\`${record.authorId}\`` }
          ]);
          return interaction.reply({
            ephemeral: true,
            embeds: [new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle(`Confession #${id} — Private Identity`)
              .setDescription(`**Submitter:** ${record.authorTag}\n**Mention:** <@${record.authorId}>\n**User ID:** \`${record.authorId}\`\n**Status:** ${record.status}\n**Submitted:** ${formatDiscordTime(record.createdAt)}`)
              .addFields({ name: 'Content', value: record.text.slice(0, 1024) || '*No text*' })
              .setFooter({ text: 'Owner/Admin only • This lookup is audit-logged' })
            ]
          });
        }

        if (sub === 'approve') {
          if (record.status !== 'pending') return interaction.reply({ ephemeral: true, content: `Confession #${id} is not pending.` });
          await postConfession(interaction.guild, gd, record);
          record.reviewedBy = interaction.user.id;
          record.history.push({ action: 'approved', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          if (record.reviewChannelId && record.reviewMessageId) {
            const reviewCh = await interaction.guild.channels.fetch(record.reviewChannelId).catch(() => null);
            const reviewMsg = reviewCh?.isTextBased() ? await reviewCh.messages.fetch(record.reviewMessageId).catch(() => null) : null;
            if (reviewMsg) await reviewMsg.edit({ components: [] }).catch(() => {});
          }
          await sendLog(interaction.guild, `✅ Confession #${id} approved`, `Approved by <@${interaction.user.id}>.`);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} approved and posted.` });
        }

        if (sub === 'reject') {
          if (record.status !== 'pending') return interaction.reply({ ephemeral: true, content: `Confession #${id} is not pending.` });
          const reason = interaction.options.getString('reason') || 'No reason provided';
          record.status = 'rejected';
          record.reviewedBy = interaction.user.id;
          record.rejectionReason = reason;
          record.history.push({ action: 'rejected', at: new Date().toISOString(), by: interaction.user.id, reason });
          await saveDb();
          await sendLog(interaction.guild, `❌ Confession #${id} rejected`, `Rejected by <@${interaction.user.id}>.`, [
            { name: 'Reason', value: reason.slice(0, 1024) }
          ]);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} rejected.` });
        }

        if (sub === 'hide') {
          const msg = await fetchPublicMessage(interaction.guild, record);
          if (msg) await msg.delete().catch(() => {});
          record.status = 'hidden';
          record.history.push({ action: 'hidden', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await sendLog(interaction.guild, `🙈 Confession #${id} hidden`, `Hidden by <@${interaction.user.id}>.`);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} was hidden. Its audit record is preserved.` });
        }

        if (sub === 'restore') {
          if (!['hidden', 'deleted_by_author', 'error'].includes(record.status)) {
            return interaction.reply({ ephemeral: true, content: `Confession #${id} is not in a restorable state.` });
          }
          await postConfession(interaction.guild, gd, record);
          record.history.push({ action: 'restored', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await sendLog(interaction.guild, `♻️ Confession #${id} restored`, `Restored by <@${interaction.user.id}>.`);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} was reposted.` });
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'confess-modal') {
        const text = interaction.fields.getTextInputValue('text');
        return submitConfession(interaction, text);
      }

      if (interaction.customId.startsWith('reply-modal:')) {
        const id = Number(interaction.customId.split(':')[1]);
        const gd = getGuildData(interaction.guildId);
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        const record = gd.confessions[String(id)];
        if (!record || record.status !== 'posted') return interaction.reply({ ephemeral: true, content: 'That confession is no longer available.' });
        if (!gd.settings.allowReplies) return interaction.reply({ ephemeral: true, content: 'Anonymous replies are disabled.' });
        const text = interaction.fields.getTextInputValue('text');
        const bad = blockedWord(gd, text);
        if (bad) return interaction.reply({ ephemeral: true, content: 'Your reply contains a blocked word or phrase.' });

        const channel = await interaction.guild.channels.fetch(record.publicChannelId).catch(() => null);
        if (!channel?.isTextBased()) return interaction.reply({ ephemeral: true, content: 'The confession channel could not be found.' });
        const msg = await channel.send({ embeds: [replyEmbed(gd, id, text)] });
        record.replies.push({
          id: record.replies.length + 1,
          authorId: interaction.user.id,
          authorTag: interaction.user.tag,
          text,
          createdAt: new Date().toISOString(),
          publicMessageId: msg.id,
        });
        await saveDb();
        await sendLog(interaction.guild, `↩️ Anonymous reply to Confession #${id}`, `Reply by <@${interaction.user.id}> (\`${interaction.user.id}\`)`, [
          { name: 'Reply', value: text.slice(0, 1024) }
        ]);
        return interaction.reply({ ephemeral: true, content: 'Anonymous reply posted.' });
      }

      if (interaction.customId.startsWith('report-modal:')) {
        const id = Number(interaction.customId.split(':')[1]);
        const gd = getGuildData(interaction.guildId);
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        const record = gd.confessions[String(id)];
        if (!record) return interaction.reply({ ephemeral: true, content: 'That confession no longer exists.' });
        const reason = interaction.fields.getTextInputValue('reason');
        record.reports.push({
          reporterId: interaction.user.id,
          reporterTag: interaction.user.tag,
          reason,
          at: new Date().toISOString(),
        });
        await saveDb();
        await sendLog(interaction.guild, `🚩 Confession #${id} reported`, `Reported by <@${interaction.user.id}> (\`${interaction.user.id}\`)`, [
          { name: 'Reason', value: reason.slice(0, 1024) },
          { name: 'Original submitter', value: `<@${record.authorId}> (\`${record.authorId}\`)` },
        ]);
        return interaction.reply({ ephemeral: true, content: 'Your report was sent privately' });
      }

      if (interaction.customId.startsWith('reject-modal:')) {
        if (!isAdmin(interaction)) return interaction.reply({ ephemeral: true, content: 'Administrator permission is required.' });
        const id = Number(interaction.customId.split(':')[1]);
        const gd = getGuildData(interaction.guildId);
        const record = gd.confessions[String(id)];
        if (!record || record.status !== 'pending') return interaction.reply({ ephemeral: true, content: 'That confession is no longer pending.' });
        const reason = interaction.fields.getTextInputValue('reason');
        record.status = 'rejected';
        record.reviewedBy = interaction.user.id;
        record.rejectionReason = reason;
        record.history.push({ action: 'rejected', at: new Date().toISOString(), by: interaction.user.id, reason });
        await saveDb();
        await sendLog(interaction.guild, `❌ Confession #${id} rejected`, `Rejected by <@${interaction.user.id}>.`, [
          { name: 'Reason', value: reason.slice(0, 1024) }
        ]);
        return interaction.reply({ ephemeral: true, content: `Confession #${id} rejected.` });
      }
    }

    if (interaction.isButton()) {
      const [action, rawId] = interaction.customId.split(':');
      const id = Number(rawId);
      const gd = getGuildData(interaction.guildId);
      const record = gd.confessions[String(id)];
      if (!record) return interaction.reply({ ephemeral: true, content: 'That confession no longer exists.' });

      if (action === 'reply') {
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        if (!gd.settings.allowReplies) return interaction.reply({ ephemeral: true, content: 'Anonymous replies are disabled.' });
        const modal = new ModalBuilder().setCustomId(`reply-modal:${id}`).setTitle(`Reply to Confession #${id}`);
        const input = new TextInputBuilder()
          .setCustomId('text')
          .setLabel('Anonymous reply (Anonymous mode enabled)')
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(1)
          .setMaxLength(1800)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (action === 'report') {
        if (!await isVerified(interaction, gd.settings)) return interaction.reply({ ephemeral: true, content: 'Verified role required.' });
        const modal = new ModalBuilder().setCustomId(`report-modal:${id}`).setTitle(`Report Confession #${id}`);
        const input = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why are you reporting this confession?')
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(2)
          .setMaxLength(1000)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (['approve', 'reject', 'inspect'].includes(action)) {
        if (!isAdmin(interaction)) return interaction.reply({ ephemeral: true, content: 'Server Owner or Administrator permission is required.' });

        if (action === 'approve') {
          if (record.status !== 'pending') return interaction.reply({ ephemeral: true, content: 'This confession is no longer pending.' });
          await postConfession(interaction.guild, gd, record);
          record.reviewedBy = interaction.user.id;
          record.history.push({ action: 'approved', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await interaction.message.edit({ components: [] }).catch(() => {});
          await sendLog(interaction.guild, `✅ Confession #${id} approved`, `Approved by <@${interaction.user.id}>.`);
          return interaction.reply({ ephemeral: true, content: `Confession #${id} approved and posted.` });
        }

        if (action === 'reject') {
          const modal = new ModalBuilder().setCustomId(`reject-modal:${id}`).setTitle(`Reject Confession #${id}`);
          const input = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason for rejection')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(500)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (action === 'inspect') {
          record.history.push({ action: 'identity_inspected', at: new Date().toISOString(), by: interaction.user.id });
          await saveDb();
          await sendLog(interaction.guild, `👁️ Identity inspected for Confession #${id}`, `<@${interaction.user.id}> inspected the submitter identity.`);
          return interaction.reply({
            ephemeral: true,
            content: `**Confession #${id} submitter:** ${record.authorTag} • <@${record.authorId}> • \`${record.authorId}\`\nThis lookup was audit-logged.`,
          });
        }
      }
    }
  } catch (err) {
    const errorId = makeErrorId();
    console.error(`Interaction error ${errorId}:`, err);
    const payload = { ephemeral: true, content: `Something went wrong (error ID: ${errorId}). Please tell a Server Owner or Admin.` };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
    void sendErrorLog(interaction.guild, err, interaction.commandName || interaction.customId || 'Interaction', errorId, interaction.user?.id);
  }
});

if (require.main === module) (async () => {
  try {
    await deployCommands();
    await client.login(TOKEN);
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();

module.exports = { commands, getGuildData, isRestricted, sendErrorLog, confirmationText };
