require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    WebhookClient,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    PermissionFlagsBits,
    Collection
} = require('discord.js');
const { Sequelize, DataTypes } = require('sequelize');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const PREFIX = "!";
const WEBHOOK_URL = process.env.WEBHOOK;
const webhook = WEBHOOK_URL ? new WebhookClient({ url: WEBHOOK_URL }) : null;
const KEY_PREFIX = "VORAHUB";
const SCRIPT_URL = process.env.SCRIPT_URL || "https://vorahub.xyz/loader";
const WHITELIST_SCRIPT_LINK = process.env.WHITELIST_SCRIPT_LINK || "https://discord.com/channels/1434540370284384338/1434755316808941718/1463912895501959374";
const PREMIUM_ROLE_ID = process.env.PREMIUM_ROLE_ID || "1434842978932752405";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || "1464892436466892800";
const CACHE_DURATION = 300000;
const COOLDOWN_DURATION = 3000;

// ==================== DATABASE CONNECTION (SQLite) ====================
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite',
    logging: false
});

// ==================== MODELS ====================
const Key = sequelize.define('Key', {
    id: { type: DataTypes.STRING, primaryKey: true },
    userId: { type: DataTypes.STRING },
    discordTag: { type: DataTypes.STRING },
    hwid: { type: DataTypes.TEXT, defaultValue: "" },
    hwidLimit: { type: DataTypes.INTEGER, defaultValue: 1 },
    feature: { type: DataTypes.STRING },
    expiresAt: { type: DataTypes.DATE },
    isWhitelisted: { type: DataTypes.BOOLEAN, defaultValue: false },
    isUsed: { type: DataTypes.BOOLEAN, defaultValue: false },
    usedAt: { type: DataTypes.DATE },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    createdBy: { type: DataTypes.STRING },
    status: { type: DataTypes.STRING, defaultValue: 'active' }
}, { timestamps: false });

const Whitelist = sequelize.define('Whitelist', {
    userId: { type: DataTypes.STRING, primaryKey: true },
    discordTag: { type: DataTypes.STRING },
    key: { type: DataTypes.STRING },
    addedBy: { type: DataTypes.STRING },
    addedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { timestamps: false });

const Blacklist = sequelize.define('Blacklist', {
    userId: { type: DataTypes.STRING, primaryKey: true },
    discordTag: { type: DataTypes.STRING },
    reason: { type: DataTypes.STRING },
    addedBy: { type: DataTypes.STRING },
    addedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { timestamps: false });

const GeneratedKey = sequelize.define('GeneratedKey', {
    id: { type: DataTypes.STRING, primaryKey: true },
    createdBy: { type: DataTypes.STRING },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    expiresInDays: { type: DataTypes.INTEGER },
    status: { type: DataTypes.STRING, defaultValue: 'pending' }
}, { timestamps: false });

// ==================== CACHE & UTILS ====================
class LRUCache {
    constructor(maxSize = 2000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    get(key) {
        if (!this.cache.has(key)) return null;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, value);
    }
    delete(key) { return this.cache.delete(key); }
}

const userKeyCache = new LRUCache(2000);
const cooldowns = new Collection();
const activeOperations = new Collection();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ]
});

function generateKey() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const bytes = crypto.randomBytes(12);
    const hex = bytes.toString('hex').toUpperCase();
    const parts = hex.match(/.{1,6}/g);
    return `${KEY_PREFIX}-${timestamp.slice(-6)}-${parts[0]}-${parts[1]}`;
}

async function getUserActiveKeys(userId, discordTag, forceRefresh = false) {
    const cached = userKeyCache.get(userId);
    if (!forceRefresh && cached && cached.expires > Date.now()) return cached.keys;

    try {
        const { Op } = require('sequelize');
        const keys = await Key.findAll({
            where: {
                [Op.or]: [{ userId }, { discordTag }],
                isUsed: true
            }
        });

        const validKeys = keys.filter(k => k.isWhitelisted || !k.expiresAt || new Date(k.expiresAt) > new Date());
        const keyIds = validKeys.map(k => k.id);

        userKeyCache.set(userId, { keys: keyIds, expires: Date.now() + CACHE_DURATION });
        return keyIds;
    } catch (err) {
        console.error(`Error Fetch keys for ${userId}:`, err);
        return [];
    }
}

async function invalidateUserCache(userId, discordTag) {
    userKeyCache.delete(userId);
    await getUserActiveKeys(userId, discordTag, true);
}

async function logAction(title, executor, target, action, extra = "") {
    if (!webhook) return;
    try {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .addFields(
                { name: "Executor", value: executor || "System", inline: true },
                { name: "Target", value: target || "-", inline: true },
                { name: "Action", value: action, inline: true },
                { name: "Extra", value: extra || "-", inline: false },
                { name: "Time", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setColor("#0099ff")
            .setTimestamp();
        await webhook.send({ embeds: [embed] });
    } catch (e) {
        console.error("[WEBHOOK ERROR]", e.message);
    }
}

async function safeReply(interaction, opts) {
    try {
        const options = typeof opts === 'string' ? { content: opts, ephemeral: true } : opts;
        if (!options.ephemeral && options.ephemeral !== false) options.ephemeral = true;
        if (interaction.deferred && !interaction.replied) return await interaction.editReply(options);
        if (!interaction.replied) return await interaction.reply(options);
        return await interaction.followUp(options);
    } catch (err) {
        console.error('[REPLY ERROR]', err.message);
    }
}

// ==================== MIGRATION   ====================
function firestoreDate(obj) {
    if (!obj) return null;
    if (obj._seconds) return new Date(obj._seconds * 1000);
    return new Date(obj);
}

async function runMigrationIfNeeded() {
    try {
        const count = await Key.count();
        if (count > 0) return;

        console.log('Database empty. Checking for export files to auto-migrate...');
        const exportDir = path.join(__dirname, 'export');
        if (!fs.existsSync(exportDir)) {
            console.log('ℹ️ No export directory found. Skipping migration.');
            return;
        }

        if (fs.existsSync(path.join(exportDir, 'whitelist.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(exportDir, 'whitelist.json'), 'utf8'));
            console.log(`Migrating whitelist...`);
            await Whitelist.bulkCreate(data.map(item => ({
                userId: item.userId,
                discordTag: item.discordTag,
                key: item.key,
                addedBy: item.addedBy,
                addedAt: firestoreDate(item.addedAt)
            })), { ignoreDuplicates: true });
        }

        if (fs.existsSync(path.join(exportDir, 'blacklist.json'))) {
            const content = fs.readFileSync(path.join(exportDir, 'blacklist.json'), 'utf8');
            if (content && content.trim() !== "[]") {
                const data = JSON.parse(content);
                console.log(`Migrating blacklist...`);
                await Blacklist.bulkCreate(data.map(item => ({
                    userId: item.userId || item.id,
                    discordTag: item.discordTag || "Unknown",
                    reason: item.reason || "Migrated",
                    addedBy: item.addedBy || "System",
                    addedAt: firestoreDate(item.addedAt)
                })), { ignoreDuplicates: true });
            }
        }

        if (fs.existsSync(path.join(exportDir, 'generated_keys.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(exportDir, 'generated_keys.json'), 'utf8'));
            console.log(`Migrating generated keys...`);
            const chunks = [];
            const BATCH_SIZE = 1000;
            for (let i = 0; i < data.length; i += BATCH_SIZE) {
                chunks.push(data.slice(i, i + BATCH_SIZE));
            }

            for (const chunk of chunks) {
                await GeneratedKey.bulkCreate(chunk.map(item => ({
                    id: item.id || item.key,
                    createdBy: item.createdBy,
                    createdAt: firestoreDate(item.createdAt),
                    expiresInDays: item.expiresInDays,
                    status: item.status || 'pending'
                })).filter(x => x.id), { ignoreDuplicates: true });
            }
        }

        if (fs.existsSync(path.join(exportDir, 'keys.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(exportDir, 'keys.json'), 'utf8'));
            console.log(`Migrating active keys...`);

            const docs = data.map(item => ({
                id: item.id,
                userId: item.userId,
                discordTag: item.usedByDiscord,
                hwid: item.hwid,
                hwidLimit: item.hwidLimit,
                feature: item.game || (item.gameId ? String(item.gameId) : null),
                expiresAt: firestoreDate(item.expiresAt),
                isWhitelisted: item.whitelisted || false,
                isUsed: item.used || false,
                usedAt: firestoreDate(item.usedAt),
                createdAt: firestoreDate(item.createdAt),
                status: 'active'
            }));

            const BATCH = 1000;
            for (let i = 0; i < docs.length; i += BATCH) {
                await Key.bulkCreate(docs.slice(i, i + BATCH), { ignoreDuplicates: true }).catch(err => console.error("Batch Error:", err.message));
                process.stdout.write('.');
            }
            console.log('\nAuto-migration complete!');
        }
    } catch (err) {
        console.error('Auto-migration failed:', err);
    }
}

// ==================== COMMANDS ====================
client.once('ready', async () => {
    console.log(`${client.user.tag} Online!`);
    client.user.setActivity('Vorahub On Top', { type: 4 });

    const commands = [
        new SlashCommandBuilder().setName('whitelist').setDescription('Manage whitelist')
            .addSubcommand(s => s.setName('add').setDescription('Add user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('List whitelist')),

        new SlashCommandBuilder().setName('blacklist').setDescription('Manage blacklist')
            .addSubcommand(s => s.setName('add').setDescription('Add user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('List blacklist')),

        new SlashCommandBuilder().setName('genkey').setDescription('Generate Key')
            .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
            .addUserOption(o => o.setName('user').setDescription('Target User')),

        new SlashCommandBuilder().setName('removekey').setDescription('Remove user key')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

        new SlashCommandBuilder().setName('sethwidlimit').setDescription('Set HWID Limit')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
            .addIntegerOption(o => o.setName('limit').setDescription('Limit').setRequired(true)),

        new SlashCommandBuilder().setName('checkkey').setDescription('Debug Key')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

        new SlashCommandBuilder().setName('syncvip').setDescription('Sync VIP Role'),
        new SlashCommandBuilder().setName('listvip').setDescription('List VIP w/o Key'),
        new SlashCommandBuilder().setName('stats').setDescription('View Stats')
    ];

    await client.application.commands.set(commands);
    console.log('Commands Registered');
});

client.on('interactionCreate', async (interaction) => {
    try {
        const userId = interaction.user.id;
        if (interaction.isChatInputCommand()) {
            if (!interaction.member?.roles.cache.has(STAFF_ROLE_ID))
                return safeReply(interaction, "❌ Access Denied");

            const { commandName } = interaction;

            if (commandName === 'whitelist') {
                const sub = interaction.options.getSubcommand();
                if (sub === 'add') {
                    await interaction.deferReply({ ephemeral: true });
                    const target = interaction.options.getUser('user');
                    if (await Whitelist.findByPk(target.id)) return interaction.editReply(`⚠️ ${target.tag} already whitelisted.`);
                    const newKey = generateKey();
                    await Whitelist.create({ userId: target.id, discordTag: target.tag, key: newKey, addedBy: interaction.user.tag });
                    await Key.create({ id: newKey, userId: target.id, discordTag: target.tag, feature: 'whitelist', isWhitelisted: true, isUsed: true, createdAt: new Date() });
                    await logAction("WHITELIST ADD", interaction.user.tag, target.tag, "Add", `Key: ${newKey}`);
                    await invalidateUserCache(target.id, target.tag);
                    return interaction.editReply(`✅ Whitelisted **${target.tag}** successfully.`);
                }
                if (sub === 'remove') {
                    await interaction.deferReply({ ephemeral: true });
                    const target = interaction.options.getUser('user');
                    const wl = await Whitelist.findByPk(target.id);
                    if (!wl) return interaction.editReply('⚠️ Not whitelisted.');
                    await wl.destroy();
                    if (wl.key) await Key.destroy({ where: { id: wl.key } });
                    await logAction("WHITELIST REMOVE", interaction.user.tag, target.tag, "Remove");
                    await invalidateUserCache(target.id, target.tag);
                    return interaction.editReply(`✅ Removed **${target.tag}** from whitelist.`);
                }
                if (sub === 'list') {
                    await interaction.deferReply({ ephemeral: true });
                    const docs = await Whitelist.findAll({ limit: 50, order: [['addedAt', 'DESC']] });
                    const list = docs.map((d, i) => `${i + 1}. **${d.discordTag}** - \`${d.key}\``).join('\n') || "Empty";
                    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle("Whitelist").setDescription(list)] });
                }
            }

            if (commandName === 'blacklist') {
                const sub = interaction.options.getSubcommand();
                if (sub === 'add') {
                    await interaction.deferReply({ ephemeral: true });
                    const target = interaction.options.getUser('user');
                    if (await Blacklist.findByPk(target.id)) return interaction.editReply('⚠️ Already blacklisted.');
                    await Blacklist.create({ userId: target.id, discordTag: target.tag, addedBy: interaction.user.tag });
                    await Whitelist.destroy({ where: { userId: target.id } });
                    const deleted = await Key.destroy({ where: { userId: target.id } });
                    await logAction("BLACKLIST ADD", interaction.user.tag, target.tag, "Add", `Keys Deleted: ${deleted}`);
                    await invalidateUserCache(target.id, target.tag);
                    return interaction.editReply(`✅ Blacklisted **${target.tag}**. Deleted ${deleted} keys.`);
                }
                if (sub === 'remove') {
                    await interaction.deferReply({ ephemeral: true });
                    const target = interaction.options.getUser('user');
                    const res = await Blacklist.destroy({ where: { userId: target.id } });
                    if (!res) return interaction.editReply('⚠️ Not blacklisted.');
                    await logAction("BLACKLIST REMOVE", interaction.user.tag, target.tag, "Remove");
                    return interaction.editReply(`✅ Unblacklisted **${target.tag}**.`);
                }
            }

            if (commandName === 'genkey') {
                await interaction.deferReply({ ephemeral: true });
                const amount = interaction.options.getInteger('amount');
                const target = interaction.options.getUser('user');
                const keys = [];
                const docs = [];
                for (let i = 0; i < amount; i++) {
                    const k = generateKey();
                    keys.push(k);
                    docs.push({ id: k, createdBy: interaction.user.tag, createdAt: new Date(), expiresInDays: null, status: 'pending' });
                }
                await GeneratedKey.bulkCreate(docs);
                await logAction("GENKEY", interaction.user.tag, target ? target.tag : "Channel", "Generate", `Amount: ${amount}`);
                const embed = new EmbedBuilder().setTitle("Generated Keys").setDescription(`\`\`\`${keys.join('\n')}\`\`\``).setColor('Green');
                if (target) {
                    try { await target.send({ embeds: [embed] }); return interaction.editReply(`✅ Sent ${amount} keys to ${target.tag}`); }
                    catch { return interaction.editReply({ content: `⚠️ Failed to DM ${target.tag}`, embeds: [embed] }); }
                }
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'stats') {
                await interaction.deferReply({ ephemeral: true });
                const [k, w, b, g] = await Promise.all([
                    Key.count(),
                    Whitelist.count(),
                    Blacklist.count(),
                    GeneratedKey.count()
                ]);
                const embed = new EmbedBuilder().setTitle("Stats").addFields({ name: "Keys", value: String(k), inline: true }, { name: "Whitelist", value: String(w), inline: true }, { name: "Blacklist", value: String(b), inline: true }, { name: "Generated", value: String(g), inline: true }).setColor('Blue');
                return interaction.editReply({ embeds: [embed] });
            }
        }

        if (interaction.isButton() || interaction.isModalSubmit()) {
            if (interaction.customId === 'redeem_modal') {
                const modal = new ModalBuilder().setCustomId('redeem_submit').setTitle("Redeem Key")
                    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('key_input').setLabel("Key").setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'redeem_submit') {
                await interaction.deferReply({ ephemeral: true });
                const keyInput = interaction.fields.getTextInputValue('key_input').trim().toUpperCase();
                if (await Blacklist.findByPk(userId)) return interaction.editReply("❌ You are blacklisted.");
                const genKey = await GeneratedKey.findByPk(keyInput);
                if (!genKey) return interaction.editReply("❌ Invalid Key.");
                if (await Key.findByPk(keyInput)) return interaction.editReply("❌ Key already used.");
                await GeneratedKey.destroy({ where: { id: keyInput } });
                const expiresAt = genKey.expiresInDays ? new Date(Date.now() + genKey.expiresInDays * 86400000) : null;
                await Key.create({ id: keyInput, userId, discordTag: interaction.user.tag, status: 'active', isUsed: false, alreadyRedeem: true, expiresAt, createdAt: new Date() });
                await logAction("REDEEM", interaction.user.tag, keyInput, "Success");
                await invalidateUserCache(userId, interaction.user.tag);
                if (interaction.guild) {
                    const member = await interaction.guild.members.fetch(userId).catch(() => null);
                    if (member) await member.roles.add(PREMIUM_ROLE_ID).catch(() => null);
                }
                return interaction.editReply("✅ Key Redeemed!");
            }
        }
    } catch (error) {
        console.error("Interaction Error:", error);
        safeReply(interaction, "❌ Error occurred.");
    }
});

// ==================== STARTUP ====================
(async () => {
    try {
        console.log('Connecting to SQLite...');
        await sequelize.authenticate();
        console.log('Connected to SQLite');

        await sequelize.sync();
        console.log('Database Synced');

        await runMigrationIfNeeded();

        if (!process.env.TOKEN) {
            console.error('❌ ERROR: TOKEN is missing in .env');
        } else {
            console.log('Logging in to Discord...');
            await client.login(process.env.TOKEN);
        }
    } catch (err) {
        console.error('Startup Error:', err);
    }
})();
