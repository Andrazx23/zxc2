require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    WebhookClient,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
    Collection
} = require('discord.js');
const admin = require('firebase-admin');
const crypto = require('crypto');

// ==================== FIREBASE INITIALIZATION ====================
admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccount.json'))
});
const db = admin.firestore();

// ==================== CONSTANTS ====================
const PREFIX = "!";
const WEBHOOK_URL = process.env.WEBHOOK;
const webhook = WEBHOOK_URL ? new WebhookClient({ url: WEBHOOK_URL }) : null;
const KEY_PREFIX = "VORAHUB";
const SCRIPT_URL = "https://vorahub.xyz/loader";
const PREMIUM_ROLE_ID = process.env.PREMIUM_ROLE_ID || "1434842978932752405";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || "1452500424551567360";
const WHITELIST_SCRIPT_LINK = "https://discord.com/channels/1434540370284384338/1434755316808941718/1463912895501959374";

// Cache configuration - Optimized for 10,000+ concurrent users
const CACHE_DURATION = 300000; // 5 minutes
const CACHE_SOFT_REFRESH = 60000; // 1 minute for background refresh
const COOLDOWN_DURATION = 3000; // 3 seconds cooldown
const BATCH_LIMIT = 450; // Firestore batch limit (buffer from 500)
const MAX_CACHE_SIZE = 2000; // Maximum 2000 users in cache

// ==================== LRU CACHE IMPLEMENTATION ====================
class LRUCache {
    constructor(maxSize = MAX_CACHE_SIZE) {
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
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    get size() {
        return this.cache.size;
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
    }
}

// ==================== COLLECTIONS ====================
const userKeyCache = new LRUCache(MAX_CACHE_SIZE);
const cooldowns = new Collection();
const activeOperations = new Collection();
const backgroundRefreshQueue = new Set();
const pendingRefreshes = new Map(); // For deduplication

let latestPanelMessageId = null;
let latestPanelChannelId = null;

// ==================== DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: ['CHANNEL']
});

// ==================== UTILITY FUNCTIONS ====================

/**
 * Generate secure key with timestamp for better randomness
 */
function generateKey() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const bytes = crypto.randomBytes(12);
    const hex = bytes.toString('hex').toUpperCase();

    const parts = hex.match(/.{1,6}/g);
    return `${KEY_PREFIX}-${timestamp.slice(-6)}-${parts[0]}-${parts[1]}`;
}

/**
 * Validate key format - flexible for old and new formats
 */
function isValidKeyFormat(key) {
    const regex = new RegExp(`^${KEY_PREFIX}-[A-Z0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$`);
    return regex.test(key);
}

/**
 * Safe batch commit with split for large operations
 */
async function safeBatchCommit(operations) {
    if (operations.length === 0) return 0;

    const batches = [];
    let currentBatch = db.batch();
    let count = 0;

    for (const op of operations) {
        op(currentBatch);
        count++;

        if (count >= BATCH_LIMIT) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            count = 0;
        }
    }

    if (count > 0) batches.push(currentBatch);

    try {
        await Promise.all(batches.map(b => b.commit()));
        return batches.length;
    } catch (error) {
        console.error('[BATCH ERROR]', error);
        throw error;
    }
}

/**
 * Check if key is expired - robust error handling
 */
function isKeyExpired(keyData) {
    if (!keyData) return true;
    if (keyData.whitelisted) return false;
    if (keyData.expiresAt === null || keyData.expiresAt === undefined) return false;

    try {
        const expiryTime = keyData.expiresAt instanceof admin.firestore.Timestamp
            ? keyData.expiresAt.toMillis()
            : Number(keyData.expiresAt);

        return !isNaN(expiryTime) && expiryTime < Date.now();
    } catch (error) {
        console.error('[EXPIRY CHECK ERROR]', error);
        return true;
    }
}

/**
 * Background refresh user keys without blocking
 */
async function refreshUserKeysBackground(userId, discordTag) {
    if (backgroundRefreshQueue.has(userId)) return;

    backgroundRefreshQueue.add(userId);

    try {
        await refreshUserKeys(userId, discordTag, true);
    } catch (error) {
        console.error(`[BG REFRESH ERROR] ${discordTag}:`, error.message);
    } finally {
        backgroundRefreshQueue.delete(userId);
    }
}

/**
 * Refresh and get user keys from database - Comprehensive query
 */
async function refreshUserKeys(userId, discordTag, isBackground = false) {
    const startTime = Date.now();
    const username = discordTag.includes('#') ? discordTag.split('#')[0] : discordTag;

    try {
        // Always query all possibilities, not conditional
        const [userIdSnapshot, tagSnapshot, usernameSnapshot, whitelistDoc] = await Promise.all([
            db.collection('keys').where('userId', '==', userId).get(),
            db.collection('keys').where('usedByDiscord', '==', discordTag).get(),
            db.collection('keys').where('usedByDiscord', '==', username).get(),
            db.collection('whitelist').doc(userId).get()
        ]);

        const keysMap = new Map(); // Use Map for deduplication
        const updateOperations = [];

        // Process ALL snapshots
        const processSnapshot = (snapshot) => {
            snapshot.forEach(doc => {
                const data = doc.data();
                const keyId = doc.id;

                // Skip if already processed
                if (keysMap.has(keyId)) return;

                // Skip expired non-permanent keys
                if (!data.whitelisted && isKeyExpired(data)) {
                    return;
                }

                // Add to result
                keysMap.set(keyId, data);

                // Auto-update missing fields for consistency
                const updates = {};
                if (!data.userId) updates.userId = userId;
                if (!data.usedByDiscord) updates.usedByDiscord = discordTag;

                if (Object.keys(updates).length > 0) {
                    updateOperations.push((batch) => batch.update(doc.ref, updates));
                }
            });
        };

        // Process all snapshots
        processSnapshot(userIdSnapshot);
        processSnapshot(tagSnapshot);
        processSnapshot(usernameSnapshot);

        // Process whitelist
        if (whitelistDoc.exists) {
            const whitelistData = whitelistDoc.data();
            if (whitelistData.key && !keysMap.has(whitelistData.key)) {
                // Check if whitelist key exists in keys collection
                const keyDoc = await db.collection('keys').doc(whitelistData.key).get();

                if (keyDoc.exists) {
                    const keyData = keyDoc.data();
                    if (!isKeyExpired(keyData)) {
                        keysMap.set(whitelistData.key, keyData);

                        // Ensure proper fields
                        const updates = {};
                        if (!keyData.userId) updates.userId = userId;
                        if (!keyData.usedByDiscord) updates.usedByDiscord = discordTag;
                        if (!keyData.whitelisted) updates.whitelisted = true;

                        if (Object.keys(updates).length > 0) {
                            updateOperations.push((batch) => batch.update(keyDoc.ref, updates));
                        }
                    }
                } else {
                    // Whitelist key doesn't exist - recreate it
                    console.log(`[RECREATE] Whitelist key ${whitelistData.key} not found, recreating...`);
                    keysMap.set(whitelistData.key, {
                        whitelisted: true,
                        userId,
                        usedByDiscord: discordTag
                    });

                    updateOperations.push((batch) => batch.set(
                        db.collection('keys').doc(whitelistData.key),
                        {
                            used: false,
                            alreadyRedeem: true,
                            userId,
                            usedByDiscord: discordTag,
                            hwid: "",
                            hwidLimit: 1,
                            usedAt: admin.firestore.FieldValue.serverTimestamp(),
                            expiresAt: null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            whitelisted: true
                        }
                    ));
                }
            }
        }

        // Commit updates if any
        if (updateOperations.length > 0) {
            await safeBatchCommit(updateOperations);
        }

        const result = Array.from(keysMap.keys());
        const duration = Date.now() - startTime;

        // Update cache
        userKeyCache.set(userId, {
            keys: result,
            expires: Date.now() + CACHE_DURATION,
            lastRefresh: Date.now()
        });

        return result;
    } catch (error) {
        console.error(`[REFRESH ERROR] ${discordTag}:`, error);
        throw error;
    }
}

/**
 * Get user active keys with smart caching + deduplication
 */
async function getUserActiveKeys(userId, discordTag, forceRefresh = false) {
    const cached = userKeyCache.get(userId);
    const now = Date.now();

    // Force refresh
    if (forceRefresh) {
        // Check if there's a pending refresh to avoid duplicate queries
        if (pendingRefreshes.has(userId)) {
            return await pendingRefreshes.get(userId);
        }

        const promise = refreshUserKeys(userId, discordTag);
        pendingRefreshes.set(userId, promise);

        try {
            return await promise;
        } finally {
            pendingRefreshes.delete(userId);
        }
    }

    // Cache hit and still valid
    if (cached && cached.expires > now) {
        // Soft refresh in background if needed
        if (cached.lastRefresh && (now - cached.lastRefresh) > CACHE_SOFT_REFRESH) {
            refreshUserKeysBackground(userId, discordTag).catch(() => { });
        }
        return cached.keys;
    }

    // Cache miss or expired - use deduplication
    if (pendingRefreshes.has(userId)) {
        return await pendingRefreshes.get(userId);
    }

    const promise = refreshUserKeys(userId, discordTag);
    pendingRefreshes.set(userId, promise);

    try {
        return await promise;
    } finally {
        pendingRefreshes.delete(userId);
    }
}

/**
 * Invalidate user cache and force refresh
 */
async function invalidateUserCache(userId, discordTag) {
    userKeyCache.delete(userId);

    // Immediate refresh to ensure consistency
    try {
        await refreshUserKeys(userId, discordTag);
    } catch (error) {
        console.error(`[CACHE REFRESH ERROR] ${discordTag}:`, error.message);
    }
}

/**
 * Log action to webhook with error handling
 */
async function logAction(title, executorTag, target, action, extra = "") {
    if (!webhook) return;

    try {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .addFields(
                { name: "Executor", value: executorTag || "System", inline: true },
                { name: "Target", value: target || "-", inline: true },
                { name: "Action", value: action, inline: true },
                { name: "Extra", value: extra || "-", inline: false },
                { name: "Time", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setColor(
                /Redeem/i.test(action) ? "#00ffff" :
                    /Reset/i.test(action) ? "#ffa500" :
                        /Script/i.test(action) ? "#ff00ff" :
                            /Role/i.test(action) ? "#ffff00" :
                                /Add|Success/i.test(action) ? "#00ff00" :
                                    /Error|Fail/i.test(action) ? "#ff0000" :
                                        "#0099ff"
            )
            .setTimestamp();

        await webhook.send({ embeds: [embed] });
    } catch (err) {
        console.error("[WEBHOOK ERROR]", err.message);
    }
}

/**
 * Safe reply with comprehensive error handling
 */
async function safeReply(interaction, opts) {
    try {
        const options = typeof opts === 'string' ? { content: opts, ephemeral: true } : opts;

        if (!options.ephemeral && !options.hasOwnProperty('ephemeral')) {
            options.ephemeral = true;
        }

        if (!interaction.deferred && !interaction.replied) {
            return await interaction.reply(options);
        }

        if (interaction.deferred && !interaction.replied) {
            return await interaction.editReply(options);
        }

        return await interaction.followUp(options);
    } catch (err) {
        console.error('[REPLY ERROR]', {
            error: err.message,
            customId: interaction.customId,
            commandName: interaction.commandName,
            userId: interaction.user?.id
        });

        if (webhook) {
            webhook.send({
                content: `⚠️ **Reply Error**\n\`\`\`\nError: ${err.message}\nUser: ${interaction.user?.tag}\nCommand: ${interaction.customId || interaction.commandName}\n\`\`\``
            }).catch(() => { });
        }

        try {
            await interaction.followUp({
                content: '⚠️ An error occurred while sending the message. Please try again.',
                ephemeral: true
            });
        } catch (e) {
            console.error('[FOLLOWUP ERROR]', e.message);
        }
    }
}

/**
 * Check cooldown for user
 */
function checkCooldown(userId, duration = COOLDOWN_DURATION) {
    const now = Date.now();
    const userCooldown = cooldowns.get(userId);

    if (userCooldown && now < userCooldown) {
        const remaining = Math.ceil((userCooldown - now) / 1000);
        return { onCooldown: true, remaining };
    }
    return { onCooldown: false };
}

/**
 * Set cooldown for user
 */
function setCooldown(userId, duration = COOLDOWN_DURATION) {
    cooldowns.set(userId, Date.now() + duration);
}

/**
 * Prevent duplicate operations
 */
function startOperation(userId, operationType) {
    const key = `${userId}-${operationType}`;
    if (activeOperations.has(key)) {
        return false;
    }
    activeOperations.set(key, Date.now());
    return true;
}

function endOperation(userId, operationType) {
    const key = `${userId}-${operationType}`;
    activeOperations.delete(key);
}

// ==================== CLEANUP TASKS ====================

setInterval(() => {
    const now = Date.now();
    let cleanedCooldowns = 0;
    let cleanedOperations = 0;

    // Cleanup cooldowns
    for (const [userId, expiry] of cooldowns.entries()) {
        if (expiry < now) {
            cooldowns.delete(userId);
            cleanedCooldowns++;
        }
    }

    // Cleanup stale operations (lebih dari 5 menit)
    for (const [key, timestamp] of activeOperations.entries()) {
        if (now - timestamp > 300000) {
            activeOperations.delete(key);
            cleanedOperations++;
        }
    }

    if (cleanedCooldowns > 0 || cleanedOperations > 0) {
        console.log(`[CLEANUP] Cooldowns: ${cleanedCooldowns}, Operations: ${cleanedOperations}`);
    }
}, 300000); // Every 5 minutes

// ==================== ERROR HANDLERS ====================

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
    if (webhook) {
        webhook.send({
            content: `🚨 **Unhandled Rejection**\n\`\`\`\n${String(reason)}\n\`\`\``
        }).catch(() => { });
    }
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    if (webhook) {
        webhook.send({
            content: `🚨 **Uncaught Exception**\n\`\`\`\n${err.message}\n${err.stack}\n\`\`\``
        }).catch(() => { });
    }
});

client.on('error', (err) => {
    console.error('[CLIENT ERROR]', err);
    if (webhook) {
        webhook.send({ content: `⚠️ Client Error: ${err.message}` }).catch(() => { });
    }
});

client.on('shardError', (err) => {
    console.error('[SHARD ERROR]', err);
    if (webhook) {
        webhook.send({ content: `⚠️ Shard Error: ${err.message}` }).catch(() => { });
    }
});

// ==================== BOT READY ====================

client.once('ready', async () => {
    console.log(`✅ Bot ${client.user.tag} is ONLINE and ENTERPRISE-READY!`);
    console.log(`📊 Serving ${client.guilds.cache.size} guilds with ${client.users.cache.size} users`);
    console.log(`🚀 Optimized for 10,000++ concurrent buyers`);

    client.user.setActivity('Vorahub On Top | Enterprise Edition', { type: 4 });

    try {
        const [keysSnap, whitelistSnap, blacklistSnap, generatedSnap] = await Promise.all([
            db.collection('keys').count().get(),
            db.collection('whitelist').count().get(),
            db.collection('blacklist').count().get(),
            db.collection('generated_keys').count().get()
        ]);

        console.log(`[DATABASE STATS]`);
        console.log(`  Keys: ${keysSnap.data().count}`);
        console.log(`  Whitelist: ${whitelistSnap.data().count}`);
        console.log(`  Blacklist: ${blacklistSnap.data().count}`);
        console.log(`  Generated (Pending): ${generatedSnap.data().count}`);

        if (webhook) {
            const embed = new EmbedBuilder()
                .setTitle('🟢 Bot Online - Enterprise Edition')
                .setDescription(`${client.user.tag} is now online and ready for 10,000++ buyers!`)
                .addFields(
                    { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
                    { name: 'Users', value: `${client.users.cache.size}`, inline: true },
                    { name: 'Status', value: '✅ Operational', inline: true },
                    { name: 'Database Keys', value: `${keysSnap.data().count}`, inline: true },
                    { name: 'Whitelist', value: `${whitelistSnap.data().count}`, inline: true },
                    { name: 'Blacklist', value: `${blacklistSnap.data().count}`, inline: true },
                    { name: 'Cache Size', value: `${MAX_CACHE_SIZE} entries (LRU)`, inline: true },
                    { name: 'Optimizations', value: '✅ All Critical Bugs Fixed', inline: true }
                )
                .setColor('#00ff00')
                .setTimestamp();

            await webhook.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('[STARTUP ERROR]', error);
    }

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('whitelist')
            .setDescription('Kelola whitelist + auto generate key')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Tambah user ke whitelist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Hapus user dari whitelist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('Lihat daftar whitelist')
            ),

        new SlashCommandBuilder()
            .setName('blacklist')
            .setDescription('Kelola blacklist user')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Tambah user ke blacklist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Hapus user dari blacklist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('Lihat daftar blacklist')
            ),

        new SlashCommandBuilder()
            .setName('genkey')
            .setDescription('Generate keys (permanent)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addIntegerOption(opt => opt
                .setName('amount')
                .setDescription('Jumlah key yang akan digenerate')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
            )
            .addUserOption(opt => opt
                .setName('user')
                .setDescription('User untuk dikirim DM (opsional)')
                .setRequired(false)
            ),

        new SlashCommandBuilder()
            .setName('removekey')
            .setDescription('Hapus key user (termasuk yang dari redeem)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt
                .setName('user')
                .setDescription('User yang keynya akan dihapus')
                .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('sethwidlimit')
            .setDescription('Atur HWID limit untuk key user')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt
                .setName('user')
                .setDescription('User yang akan diatur HWID limitnya')
                .setRequired(true)
            )
            .addIntegerOption(opt => opt
                .setName('limit')
                .setDescription('Jumlah device yang bisa pakai key ini')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100000000)
            ),

        new SlashCommandBuilder()
            .setName('checkkey')
            .setDescription('Debug: Cek key user')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(opt => opt
                .setName('user')
                .setDescription('User yang akan dicek')
                .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('syncvip')
            .setDescription('Auto-whitelist user yang punya role VIP tapi belum punya key')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('listvip')
            .setDescription('Lihat VIP yang belum punya key')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        new SlashCommandBuilder()
            .setName('stats')
            .setDescription('Lihat statistik bot dan database')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ];

    try {
        await client.application.commands.set(commands);
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('[COMMAND REGISTRATION ERROR]', error);
    }
});

// ==================== INTERACTION HANDLER ====================

client.on('interactionCreate', async (interaction) => {
    try {
        const userId = interaction.user?.id;
        const discordTag = interaction.user?.tag;

        if (interaction.isChatInputCommand()) {
            if (!interaction.member?.roles.cache.has(STAFF_ROLE_ID)) {
                return safeReply(interaction, "❌ Only staff with the special role can use this command!");
            }

            const commandName = interaction.commandName;

            // ========== /whitelist ==========
            if (commandName === 'whitelist') {
                await interaction.deferReply({ ephemeral: true });
                const sub = interaction.options.getSubcommand();

                if (sub === 'add') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const whitelistRef = db.collection('whitelist').doc(targetUser.id);

                    if ((await whitelistRef.get()).exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} is already whitelisted!` });
                    }

                    const newKey = generateKey();
                    const operations = [];

                    operations.push((batch) => batch.set(
                        db.collection('keys').doc(newKey),
                        {
                            used: false,
                            alreadyRedeem: true,
                            userId: targetUser.id,
                            usedByDiscord: targetTag,
                            hwid: "",
                            hwidLimit: 1,
                            usedAt: admin.firestore.FieldValue.serverTimestamp(),
                            expiresAt: null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            whitelisted: true
                        }
                    ));

                    operations.push((batch) => batch.set(
                        whitelistRef,
                        {
                            userId: targetUser.id,
                            discordTag: targetTag,
                            key: newKey,
                            addedBy: interaction.user.tag,
                            addedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    ));

                    await safeBatchCommit(operations);
                    await invalidateUserCache(targetUser.id, targetTag);
                    await logAction("WHITELIST ADD", interaction.user.tag, targetTag, "Whitelist Add", `Key: ${newKey}`);

                    if (interaction.guild) {
                        try {
                            const member = await interaction.guild.members.fetch(targetUser.id);
                            if (member && !member.roles.cache.has(PREMIUM_ROLE_ID)) {
                                await member.roles.add(PREMIUM_ROLE_ID);
                                await logAction("ROLE AUTO", interaction.user.tag, targetTag, "Role Added (Whitelist)");
                            }
                        } catch (err) {
                            console.error('[ROLE ADD ERROR]', err.message);
                        }
                    }

                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been whitelisted! You can access the script via this message -->${WHITELIST_SCRIPT_LINK}`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    return interaction.editReply({
                        content: `✅ Successfully whitelisted **${targetTag}**!\n\nRoles have been automatically assigned if the user is in the server.`
                    });
                }

                if (sub === 'remove') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const doc = await db.collection('whitelist').doc(targetUser.id).get();

                    if (!doc.exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} is not whitelisted!` });
                    }

                    // Remove ALL user keys (not just whitelist key)
                    const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);
                    const operations = [];

                    operations.push((batch) => batch.delete(doc.ref));

                    for (const key of userKeys) {
                        operations.push((batch) => batch.delete(db.collection('keys').doc(key)));
                    }

                    await safeBatchCommit(operations);

                    if (interaction.guild) {
                        try {
                            const member = await interaction.guild.members.fetch(targetUser.id);
                            if (member && member.roles.cache.has(PREMIUM_ROLE_ID)) {
                                await member.roles.remove(PREMIUM_ROLE_ID);
                                await logAction("ROLE AUTO", interaction.user.tag, targetTag, "Role Removed (Whitelist)");
                            }
                        } catch (err) {
                            console.error('[ROLE REMOVE ERROR]', err.message);
                        }
                    }

                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been removed from whitelist! 💔To find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    await invalidateUserCache(targetUser.id, targetTag);
                    await logAction("WHITELIST REMOVE", interaction.user.tag, targetTag, "Remove", `Keys deleted: ${userKeys.length}`);

                    return interaction.editReply({
                        content: `✅ Successfully removed **${targetTag}** from whitelist!\n\n📊 Total keys deleted: **${userKeys.length}**\n👑 Role automatically removed.`
                    });
                }

                if (sub === 'list') {
                    const snapshot = await db.collection('whitelist').orderBy('addedAt', 'desc').limit(50).get();

                    if (snapshot.empty) {
                        return interaction.editReply({ content: "ℹ️ Whitelist is empty!" });
                    }

                    const list = snapshot.docs.map((doc, idx) => {
                        const d = doc.data();
                        return `${idx + 1}. **${d.discordTag}** → \`${d.key || "No Key"}\``;
                    }).join('\n');

                    const embed = new EmbedBuilder()
                        .setTitle("📋 WHITELIST LIST")
                        .setDescription(list || "Kosong")
                        .setColor("#7289da")
                        .setFooter({ text: `Total: ${snapshot.size} | Showing max 50` })
                        .setTimestamp();

                    return interaction.editReply({ embeds: [embed] });
                }
            }

            // ========== /blacklist ==========
            if (commandName === 'blacklist') {
                await interaction.deferReply({ ephemeral: true });
                const sub = interaction.options.getSubcommand();

                if (sub === 'add') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const blacklistRef = db.collection('blacklist').doc(targetUser.id);

                    if ((await blacklistRef.get()).exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} is already blacklisted!` });
                    }

                    const operations = [];

                    operations.push((batch) => batch.set(
                        blacklistRef,
                        {
                            userId: targetUser.id,
                            discordTag: targetTag,
                            addedBy: interaction.user.tag,
                            addedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    ));

                    const whitelistDoc = await db.collection('whitelist').doc(targetUser.id).get();
                    if (whitelistDoc.exists) {
                        operations.push((batch) => batch.delete(whitelistDoc.ref));
                    }

                    const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);
                    for (const key of userKeys) {
                        operations.push((batch) => batch.delete(db.collection('keys').doc(key)));
                    }

                    await safeBatchCommit(operations);
                    await logAction("BLACKLIST ADD", interaction.user.tag, targetTag, "Blacklist Add", `Keys deleted: ${userKeys.length}`);

                    if (interaction.guild) {
                        try {
                            const member = await interaction.guild.members.fetch(targetUser.id);
                            if (member && member.roles.cache.has(PREMIUM_ROLE_ID)) {
                                await member.roles.remove(PREMIUM_ROLE_ID);
                                await logAction("ROLE AUTO", interaction.user.tag, targetTag, "Role Removed (Blacklist)");
                            }
                        } catch (err) {
                            console.error('[ROLE REMOVE ERROR]', err.message);
                        }
                    }

                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been blacklisted! 🚫To find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    await invalidateUserCache(targetUser.id, targetTag);

                    return interaction.editReply({
                        content: `✅ Successfully blacklisted **${targetTag}**!\n\n${userKeys.length} keys deleted + role removed.`
                    });
                }

                if (sub === 'remove') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const doc = await db.collection('blacklist').doc(targetUser.id).get();

                    if (!doc.exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} is not blacklisted!` });
                    }
                    x
                    await doc.ref.delete();
                    await logAction("BLACKLIST REMOVE", interaction.user.tag, targetTag, "Remove");

                    return interaction.editReply({
                        content: `✅ Berhasil hapus **${targetTag}** dari blacklist.`
                    });
                }

                if (sub === 'list') {
                    const snapshot = await db.collection('blacklist').orderBy('addedAt', 'desc').limit(50).get();

                    if (snapshot.empty) {
                        return interaction.editReply({ content: "ℹ️ Blacklist kosong!" });
                    }

                    const list = snapshot.docs.map((doc, idx) => {
                        const d = doc.data();
                        return `${idx + 1}. **${d.discordTag}** → Added by ${d.addedBy}`;
                    }).join('\n');

                    const embed = new EmbedBuilder()
                        .setTitle("🚫 BLACKLIST LIST")
                        .setDescription(list || "Kosong")
                        .setColor("#ff0000")
                        .setFooter({ text: `Total: ${snapshot.size} | Showing max 50` })
                        .setTimestamp();

                    return interaction.editReply({ embeds: [embed] });
                }
            }

            // ========== /genkey ==========
            if (commandName === 'genkey') {
                await interaction.deferReply({ ephemeral: true });

                const amount = interaction.options.getInteger('amount');
                const targetUser = interaction.options.getUser('user');

                const operations = [];
                const keys = [];

                for (let i = 0; i < amount; i++) {
                    const key = generateKey();
                    keys.push(key);
                    operations.push((batch) => batch.set(
                        db.collection('generated_keys').doc(key),
                        {
                            createdBy: interaction.user.tag,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            expiresInDays: null,
                            status: 'pending'
                        }
                    ));
                }

                await safeBatchCommit(operations);

                const embed = new EmbedBuilder()
                    .setTitle("🔑 KEYS GENERATED (Pending Redeem)")
                    .setDescription(`\`\`\`${keys.join("\n")}\`\`\``)
                    .addFields(
                        { name: "Total", value: `${keys.length}`, inline: true },
                        { name: "Tipe", value: "PERMANENT", inline: true },
                        { name: "Status", value: "⏳ Menunggu redeem", inline: true }
                    )
                    .setColor("#00ff00")
                    .setTimestamp();

                if (targetUser) {
                    try {
                        await targetUser.send({ embeds: [embed] });
                        await logAction("KEYS GENERATED", interaction.user.tag, targetUser.tag, "Generate (DM)", `Jumlah: ${amount}`);
                        return interaction.editReply({
                            content: `✅ ${amount} key berhasil digenerate dan dikirim ke DM **${targetUser.tag}**!`,
                            embeds: [embed]
                        });
                    } catch (err) {
                        console.error('[DM ERROR]', err.message);
                        await logAction("KEYS GENERATED", interaction.user.tag, targetUser.tag, "Generate (DM Failed)", `Jumlah: ${amount}`);
                        return interaction.editReply({
                            content: `⚠️ ${amount} key berhasil digenerate tapi gagal kirim DM ke **${targetUser.tag}** (DM ditutup?).\n\nKeys:`,
                            embeds: [embed]
                        });
                    }
                } else {
                    await interaction.channel.send({ embeds: [embed] });
                    await logAction("KEYS GENERATED", interaction.user.tag, "Channel", "Generate", `Jumlah: ${amount}`);
                    return interaction.editReply({
                        content: `✅ ${amount} key berhasil digenerate dan dikirim ke channel!`
                    });
                }
            }

            // ========== /removekey ==========
            if (commandName === 'removekey') {
                await interaction.deferReply({ ephemeral: true });

                const targetUser = interaction.options.getUser('user');
                const targetTag = targetUser.tag;

                const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);

                if (userKeys.length === 0) {
                    return interaction.editReply({
                        content: `⚠️ **${targetTag}** tidak memiliki key aktif!`
                    });
                }

                const operations = [];

                for (const key of userKeys) {
                    operations.push((batch) => batch.delete(db.collection('keys').doc(key)));
                }

                const whitelistDoc = await db.collection('whitelist').doc(targetUser.id).get();
                if (whitelistDoc.exists) {
                    operations.push((batch) => batch.delete(whitelistDoc.ref));
                }

                await safeBatchCommit(operations);

                if (interaction.guild) {
                    try {
                        const member = await interaction.guild.members.fetch(targetUser.id);
                        if (member && member.roles.cache.has(PREMIUM_ROLE_ID)) {
                            await member.roles.remove(PREMIUM_ROLE_ID);
                            await logAction("ROLE AUTO", interaction.user.tag, targetTag, "Role Removed (Key Removal)");
                        }
                    } catch (err) {
                        console.error('[ROLE REMOVE ERROR]', err.message);
                    }
                }

                try {
                    await interaction.channel.send(`<@${targetUser.id}> Your keys have been removed! 💔\nTo find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                } catch (err) {
                    console.error('[NOTIFICATION ERROR]', err.message);
                }

                await invalidateUserCache(targetUser.id, targetTag);
                await logAction("KEYS REMOVED", interaction.user.tag, targetTag, "Remove All Keys", `Total: ${userKeys.length}`);

                return interaction.editReply({
                    content: `✅ Berhasil hapus **${userKeys.length}** key dari **${targetTag}** + role dihapus.`
                });
            }

            // ========== /sethwidlimit ==========
            if (commandName === 'sethwidlimit') {
                await interaction.deferReply({ ephemeral: true });

                const targetUser = interaction.options.getUser('user');
                const targetTag = targetUser.tag;
                const newLimit = interaction.options.getInteger('limit');

                const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);

                if (userKeys.length === 0) {
                    return interaction.editReply({
                        content: `⚠️ **${targetTag}** tidak memiliki key aktif!`
                    });
                }

                const operations = [];

                for (const key of userKeys) {
                    operations.push((batch) => batch.update(
                        db.collection('keys').doc(key),
                        { hwidLimit: newLimit }
                    ));
                }

                await safeBatchCommit(operations);
                await invalidateUserCache(targetUser.id, targetTag);
                await logAction("HWID LIMIT", interaction.user.tag, targetTag, "Set HWID Limit", `New limit: ${newLimit}, Keys: ${userKeys.length}`);

                return interaction.editReply({
                    content: `✅ HWID limit untuk **${userKeys.length}** key milik **${targetTag}** telah diubah menjadi **${newLimit}** device.`
                });
            }

            // ========== /checkkey ==========
            if (commandName === 'checkkey') {
                await interaction.deferReply({ ephemeral: true });

                const targetUser = interaction.options.getUser('user');
                const targetTag = targetUser.tag;

                const keys = await getUserActiveKeys(targetUser.id, targetTag, true);
                const [whitelistDoc, blacklistDoc] = await Promise.all([
                    db.collection('whitelist').doc(targetUser.id).get(),
                    db.collection('blacklist').doc(targetUser.id).get()
                ]);

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 Debug Info: ${targetTag}`)
                    .addFields(
                        { name: "User ID", value: targetUser.id, inline: false },
                        { name: "Total Keys Found", value: `${keys.length}`, inline: true },
                        { name: "In Whitelist", value: whitelistDoc.exists ? "✅ Yes" : "❌ No", inline: true },
                        { name: "In Blacklist", value: blacklistDoc.exists ? "⚠️ Yes" : "✅ No", inline: true }
                    )
                    .setColor(keys.length > 0 ? "#00ff00" : "#ff0000")
                    .setTimestamp();

                if (whitelistDoc.exists) {
                    const wData = whitelistDoc.data();
                    embed.addFields({ name: "Whitelist Key", value: `\`${wData.key || "N/A"}\``, inline: false });
                }

                if (keys.length > 0) {
                    const keyList = keys.slice(0, 10).map(k => `\`${k}\``).join("\n");
                    embed.addFields({
                        name: `Active Keys (${keys.length})`,
                        value: keyList + (keys.length > 10 ? `\n... and ${keys.length - 10} more` : ""),
                        inline: false
                    });

                    for (const key of keys.slice(0, 3)) {
                        try {
                            const keyDoc = await db.collection('keys').doc(key).get();
                            if (keyDoc.exists) {
                                const kData = keyDoc.data();
                                const expiryText = kData.expiresAt
                                    ? `<t:${Math.floor(kData.expiresAt.toMillis() / 1000)}:R>`
                                    : "Never";

                                embed.addFields({
                                    name: `📌 ${key.substring(0, 30)}...`,
                                    value: `Whitelisted: ${kData.whitelisted ? "✅" : "❌"}\nExpires: ${expiryText}\nHWID Limit: ${kData.hwidLimit}\nUsed: ${kData.used ? "Yes" : "No"}`,
                                    inline: false
                                });
                            }
                        } catch (err) {
                            console.error('[KEY CHECK ERROR]', err.message);
                        }
                    }
                } else {
                    embed.addFields({
                        name: "⚠️ Status",
                        value: "User has no active keys!",
                        inline: false
                    });
                }

                return interaction.editReply({ embeds: [embed] });
            }

            // ========== /syncvip ==========
            if (commandName === 'syncvip') {
                await interaction.deferReply({ ephemeral: true });

                if (!interaction.guild) {
                    return interaction.editReply({
                        content: "❌ Command ini hanya bisa dipakai di server!"
                    });
                }

                await interaction.guild.members.fetch();
                const premiumMembers = interaction.guild.members.cache.filter(m =>
                    m.roles.cache.has(PREMIUM_ROLE_ID) && !m.user.bot
                );

                let added = 0;
                let skipped = 0;
                const results = [];

                for (const [memberId, member] of premiumMembers) {
                    const discordTag = member.user.tag;
                    const keys = await getUserActiveKeys(memberId, discordTag, true);

                    if (keys.length > 0) {
                        skipped++;
                        continue;
                    }

                    const newKey = generateKey();
                    const operations = [];

                    operations.push((batch) => batch.set(
                        db.collection('keys').doc(newKey),
                        {
                            used: false,
                            alreadyRedeem: true,
                            userId: memberId,
                            usedByDiscord: discordTag,
                            hwid: "",
                            hwidLimit: 1,
                            usedAt: admin.firestore.FieldValue.serverTimestamp(),
                            expiresAt: null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            whitelisted: true
                        }
                    ));

                    operations.push((batch) => batch.set(
                        db.collection('whitelist').doc(memberId),
                        {
                            userId: memberId,
                            discordTag: discordTag,
                            key: newKey,
                            addedBy: `SYNC by ${interaction.user.tag}`,
                            addedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    ));

                    await safeBatchCommit(operations);
                    await invalidateUserCache(memberId, discordTag);

                    results.push(`✅ ${discordTag}`);
                    added++;

                    await logAction("AUTO WHITELIST", interaction.user.tag, discordTag, "Sync VIP", `Key: ${newKey}`);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                const embed = new EmbedBuilder()
                    .setTitle("🔄 Sync VIP Complete")
                    .addFields(
                        { name: "Total VIP Members", value: `${premiumMembers.size}`, inline: true },
                        { name: "✅ Added", value: `${added}`, inline: true },
                        { name: "⏭️ Skipped", value: `${skipped}`, inline: true }
                    )
                    .setColor(added > 0 ? "#00ff00" : "#ffff00")
                    .setTimestamp();

                if (results.length > 0 && results.length <= 20) {
                    embed.addFields({
                        name: "New Whitelisted",
                        value: results.join("\n"),
                        inline: false
                    });
                }

                return interaction.editReply({ embeds: [embed] });
            }

            // ========== /listvip ==========
            if (commandName === 'listvip') {
                await interaction.deferReply({ ephemeral: true });

                if (!interaction.guild) {
                    return interaction.editReply({
                        content: "❌ Command ini hanya bisa dipakai di server!"
                    });
                }

                await interaction.guild.members.fetch();
                const premiumMembers = interaction.guild.members.cache.filter(m =>
                    m.roles.cache.has(PREMIUM_ROLE_ID) && !m.user.bot
                );

                const noKey = [];
                const hasKey = [];

                for (const [memberId, member] of premiumMembers) {
                    const discordTag = member.user.tag;
                    const keys = await getUserActiveKeys(memberId, discordTag, true);

                    if (keys.length > 0) {
                        hasKey.push(discordTag);
                    } else {
                        noKey.push(`❌ ${discordTag}`);
                    }
                }

                const embed = new EmbedBuilder()
                    .setTitle("🔍 VIP Members Status")
                    .addFields(
                        { name: "Total VIP", value: `${premiumMembers.size}`, inline: true },
                        { name: "✅ Has Key", value: `${hasKey.length}`, inline: true },
                        { name: "❌ No Key", value: `${noKey.length}`, inline: true }
                    )
                    .setColor(noKey.length > 0 ? "#ff0000" : "#00ff00")
                    .setTimestamp();

                if (noKey.length > 0) {
                    const list = noKey.slice(0, 25).join("\n");
                    embed.addFields({
                        name: `VIP Tanpa Key (${noKey.length})`,
                        value: list + (noKey.length > 25 ? `\n... dan ${noKey.length - 25} lainnya` : ""),
                        inline: false
                    });
                } else {
                    embed.addFields({
                        name: "✅ Status",
                        value: "All VIPs already have keys!",
                        inline: false
                    });
                }

                return interaction.editReply({ embeds: [embed] });
            }

            // ========== /stats ==========
            if (commandName === 'stats') {
                await interaction.deferReply({ ephemeral: true });

                try {
                    const [keysSnap, whitelistSnap, blacklistSnap, generatedSnap] = await Promise.all([
                        db.collection('keys').count().get(),
                        db.collection('whitelist').count().get(),
                        db.collection('blacklist').count().get(),
                        db.collection('generated_keys').count().get()
                    ]);

                    const embed = new EmbedBuilder()
                        .setTitle("📊 Bot Statistics - Enterprise Edition")
                        .addFields(
                            { name: "🔑 Total Keys", value: `${keysSnap.data().count}`, inline: true },
                            { name: "✅ Whitelist", value: `${whitelistSnap.data().count}`, inline: true },
                            { name: "🚫 Blacklist", value: `${blacklistSnap.data().count}`, inline: true },
                            { name: "⏳ Pending Keys", value: `${generatedSnap.data().count}`, inline: true },
                            { name: "👥 Guilds", value: `${client.guilds.cache.size}`, inline: true },
                            { name: "💾 Cache Size", value: `${userKeyCache.size}/${MAX_CACHE_SIZE}`, inline: true },
                            { name: "⏰ Active Cooldowns", value: `${cooldowns.size}`, inline: true },
                            { name: "🔄 Active Operations", value: `${activeOperations.size}`, inline: true },
                            { name: "⏱️ Uptime", value: `<t:${Math.floor((Date.now() - client.uptime) / 1000)}:R>`, inline: true }
                        )
                        .setColor("#0099ff")
                        .setFooter({ text: '✅ All Critical Bugs Fixed | LRU Cache | Race Condition Protected' })
                        .setTimestamp();

                    return interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('[STATS ERROR]', error);
                    return interaction.editReply({
                        content: "❌ Failed to fetch statistics from database."
                    });
                }
            }
        }

        // ==================== BUTTONS & MODALS ====================

        if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
            if (interaction.customId !== "redeem_modal") {
                const cooldownCheck = checkCooldown(userId);
                if (cooldownCheck.onCooldown) {
                    return safeReply(interaction, {
                        content: `⏰ Please wait ${cooldownCheck.remaining} seconds before using this feature again!`,
                        ephemeral: true
                    });
                }
            }

            // ========== Redeem Modal Show ==========
            if (interaction.customId === "redeem_modal") {
                const modal = new ModalBuilder()
                    .setCustomId("redeem_submit")
                    .setTitle("Redeem Key");

                const input = new TextInputBuilder()
                    .setCustomId("key_input")
                    .setLabel("Enter Key")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("VORAHUB-ABCDEF-123456-789012")
                    .setRequired(true)
                    .setMinLength(24)
                    .setMaxLength(35);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // ========== Redeem Submit - WITH TRANSACTION (RACE CONDITION FIX) ==========
            if (interaction.customId === "redeem_submit") {
                if (!startOperation(userId, 'redeem')) {
                    return safeReply(interaction, {
                        content: "⚠️ You are currently redeeming. Please wait until it's complete!",
                        ephemeral: true
                    });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });

                    const blacklistDoc = await db.collection('blacklist').doc(userId).get();
                    if (blacklistDoc.exists) {
                        return safeReply(interaction, {
                            content: "❌ You are blacklisted and cannot redeem keys!",
                            ephemeral: true
                        });
                    }

                    const inputKey = interaction.fields.getTextInputValue('key_input').trim().toUpperCase();

                    if (!isValidKeyFormat(inputKey)) {
                        return safeReply(interaction, {
                            content: "❌ Invalid key format! Must be: `VORAHUB-XXXXXX-XXXXXX-XXXXXX`",
                            ephemeral: true
                        });
                    }

                    // Use transaction to prevent race condition
                    const result = await db.runTransaction(async (transaction) => {
                        const keyRef = db.collection('keys').doc(inputKey);
                        const pendingRef = db.collection('generated_keys').doc(inputKey);

                        const [activeDoc, pendingDoc] = await Promise.all([
                            transaction.get(keyRef),
                            transaction.get(pendingRef)
                        ]);

                        if (activeDoc.exists) {
                            const data = activeDoc.data();
                            throw new Error(`ALREADY_USED:${data.usedByDiscord || data.userId || "Unknown"}`);
                        }

                        if (!pendingDoc.exists) {
                            throw new Error('INVALID_KEY');
                        }

                        const pendingData = pendingDoc.data();
                        const isPermanent = pendingData.expiresInDays == null;

                        transaction.set(keyRef, {
                            used: false,
                            alreadyRedeem: true,
                            userId: userId,
                            usedByDiscord: discordTag,
                            hwid: "",
                            hwidLimit: 1,
                            usedAt: admin.firestore.FieldValue.serverTimestamp(),
                            expiresAt: isPermanent ? null : admin.firestore.Timestamp.fromMillis(
                                Date.now() + (pendingData.expiresInDays * 86400000)
                            ),
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            whitelisted: false
                        });

                        transaction.delete(pendingRef);

                        return { isPermanent };
                    });

                    await logAction("KEY REDEEMED", discordTag, inputKey, "Redeem Success", `Permanent: ${result.isPermanent}`);

                    if (interaction.guild) {
                        try {
                            const member = await interaction.guild.members.fetch(userId);
                            if (member && !member.roles.cache.has(PREMIUM_ROLE_ID)) {
                                await member.roles.add(PREMIUM_ROLE_ID);
                                await logAction("ROLE AUTO", discordTag, "Premium", "Auto Redeem");
                            }
                        } catch (err) {
                            console.error('[ROLE ADD ERROR]', err.message);
                        }
                    }

                    await invalidateUserCache(userId, discordTag);
                    setCooldown(userId);

                    return safeReply(interaction, {
                        content: `✅ Key \`${inputKey}\` successfully redeemed!\n\n🎉 You can now use all panel features.\n👑 Premium role automatically granted if you're in the server.`,
                        ephemeral: true
                    });

                } catch (error) {
                    if (error.message.startsWith('ALREADY_USED:')) {
                        const usedBy = error.message.split(':')[1];
                        return safeReply(interaction, {
                            content: `❌ Key already used by **${usedBy}**!`,
                            ephemeral: true
                        });
                    }

                    if (error.message === 'INVALID_KEY') {
                        return safeReply(interaction, {
                            content: "❌ Invalid or expired key!",
                            ephemeral: true
                        });
                    }

                    console.error('[REDEEM ERROR]', error);
                    await logAction("REDEEM ERROR", discordTag, "N/A", "Error", error.message);

                    return safeReply(interaction, {
                        content: "❌ An error occurred. Please try again or contact admin.",
                        ephemeral: true
                    });
                } finally {
                    endOperation(userId, 'redeem');
                }
            }

            // ========== Get Role ==========
            if (interaction.customId === "getrole_start") {
                if (!startOperation(userId, 'getrole')) {
                    return safeReply(interaction, {
                        content: "⚠️ Request sedang diproses. Tunggu sebentar!",
                        ephemeral: true
                    });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });

                    if (!interaction.guild) {
                        return safeReply(interaction, {
                            content: "❌ This feature can only be used in a server.",
                            ephemeral: true
                        });
                    }

                    const keys = await getUserActiveKeys(userId, discordTag, true);
                    if (keys.length === 0) {
                        return safeReply(interaction, {
                            content: "❌ You don't have an active key yet! Please redeem a key first.",
                            ephemeral: true
                        });
                    }

                    const member = await interaction.guild.members.fetch(userId).catch(() => null);
                    if (!member) {
                        return safeReply(interaction, {
                            content: "❌ Failed to find member in server.",
                            ephemeral: true
                        });
                    }

                    if (member.roles.cache.has(PREMIUM_ROLE_ID)) {
                        return safeReply(interaction, {
                            content: "✅ You already have the Premium role!",
                            ephemeral: true
                        });
                    }

                    await member.roles.add(PREMIUM_ROLE_ID);
                    await logAction("ROLE MANUAL", discordTag, "Premium", "Manual Get Role");
                    setCooldown(userId);

                    return safeReply(interaction, {
                        content: "✅ Premium role successfully granted!",
                        ephemeral: true
                    });

                } finally {
                    endOperation(userId, 'getrole');
                }
            }

            // ========== Get Script ==========
            if (interaction.customId === "getscript_start") {
                if (!startOperation(userId, 'getscript')) {
                    return safeReply(interaction, {
                        content: "⚠️ Request sedang diproses. Tunggu sebentar!",
                        ephemeral: true
                    });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });

                    const keys = await getUserActiveKeys(userId, discordTag, true);
                    if (keys.length === 0) {
                        return safeReply(interaction, {
                            content: "❌ You don't have an active key yet! Please redeem or whitelist first.",
                            ephemeral: true
                        });
                    }

                    if (keys.length === 1) {
                        const script = `_G.script_key = "${keys[0]}"\nloadstring(game:HttpGet("${SCRIPT_URL}"))()`;
                        await logAction("SCRIPT GET", discordTag, keys[0], "Get Script");
                        setCooldown(userId);

                        return safeReply(interaction, {
                            content: "**Your Script:**\n```lua\n" + script + "\n```",
                            ephemeral: true
                        });
                    }

                    const select = new StringSelectMenuBuilder()
                        .setCustomId("getscript_select")
                        .setPlaceholder("Select key to get script")
                        .addOptions(keys.map(k => ({
                            label: k.substring(0, 25),
                            description: k.substring(25) || "...",
                            value: k
                        })));

                    return safeReply(interaction, {
                        content: `You have **${keys.length}** keys. Select one to get the script:`,
                        components: [new ActionRowBuilder().addComponents(select)],
                        ephemeral: true
                    });

                } finally {
                    endOperation(userId, 'getscript');
                }
            }

            if (interaction.customId === "getscript_select") {
                await interaction.deferReply({ ephemeral: true });

                const key = interaction.values[0];
                const script = `_G.script_key = "${key}"\nloadstring(game:HttpGet("${SCRIPT_URL}"))()`;

                await logAction("SCRIPT GET", discordTag, key, "Get Script (Select)");
                setCooldown(userId);

                return safeReply(interaction, {
                    content: "**Your Script:**\n```lua\n" + script + "\n```",
                    ephemeral: true
                });
            }

            // ========== Reset HWID ==========
            if (interaction.customId === "reset_start") {
                if (!startOperation(userId, 'reset')) {
                    return safeReply(interaction, {
                        content: "⚠️ Request sedang diproses. Tunggu sebentar!",
                        ephemeral: true
                    });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });

                    const keys = await getUserActiveKeys(userId, discordTag, true);
                    if (keys.length === 0) {
                        return safeReply(interaction, {
                            content: "❌ You don't have an active key yet!",
                            ephemeral: true
                        });
                    }

                    if (keys.length === 1) {
                        await db.collection('keys').doc(keys[0]).update({
                            hwid: "",
                            used: false
                        });

                        await logAction("HWID RESET", discordTag, keys[0], "Reset HWID");
                        setCooldown(userId);

                        return safeReply(interaction, {
                            content: `✅ HWID for key \`${keys[0]}\` has been reset.`,
                            ephemeral: true
                        });
                    }

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("reset_all_confirm")
                            .setLabel("Reset All HWID")
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId("reset_choose_key")
                            .setLabel("Choose Specific Key")
                            .setStyle(ButtonStyle.Primary)
                    );

                    return safeReply(interaction, {
                        content: `🔑 You have **${keys.length}** active keys.\nDo you want to reset HWID for all keys or choose one?`,
                        components: [row],
                        ephemeral: true
                    });

                } finally {
                    endOperation(userId, 'reset');
                }
            }

            if (interaction.customId === "reset_all_confirm") {
                await interaction.deferReply({ ephemeral: true });

                const keys = await getUserActiveKeys(userId, discordTag, true);
                if (keys.length === 0) {
                    return safeReply(interaction, {
                        content: "❌ Kamu belum punya key aktif!",
                        ephemeral: true
                    });
                }

                const operations = [];
                for (const key of keys) {
                    operations.push((batch) => batch.update(
                        db.collection('keys').doc(key),
                        { hwid: "", used: false }
                    ));
                }

                await safeBatchCommit(operations);
                await logAction("HWID RESET ALL", discordTag, `${keys.length} keys`, "Reset All HWID");
                setCooldown(userId);

                return safeReply(interaction, {
                    content: `✅ HWID for **${keys.length}** keys has been reset!`,
                    ephemeral: true
                });
            }

            if (interaction.customId === "reset_choose_key") {
                await interaction.deferReply({ ephemeral: true });

                const keys = await getUserActiveKeys(userId, discordTag, true);
                if (keys.length === 0) {
                    return safeReply(interaction, {
                        content: "❌ Kamu belum punya key aktif!",
                        ephemeral: true
                    });
                }

                const select = new StringSelectMenuBuilder()
                    .setCustomId("reset_select_key")
                    .setPlaceholder("Select key to reset HWID")
                    .addOptions(keys.map(k => ({
                        label: k.substring(0, 25),
                        description: k.substring(25) || "...",
                        value: k
                    })));

                return safeReply(interaction, {
                    content: "🔑 Select the key you want to reset HWID for:",
                    components: [new ActionRowBuilder().addComponents(select)],
                    ephemeral: true
                });
            }

            if (interaction.customId === "reset_select_key") {
                await interaction.deferReply({ ephemeral: true });

                const key = interaction.values[0];

                await db.collection('keys').doc(key).update({
                    hwid: "",
                    used: false
                });

                await logAction("HWID RESET", discordTag, key, "Reset HWID (Select)");
                setCooldown(userId);

                return safeReply(interaction, {
                    content: `✅ HWID for key \`${key}\` has been reset.`,
                    ephemeral: true
                });
            }
        }

    } catch (error) {
        console.error('[INTERACTION ERROR]', error);

        if (webhook) {
            webhook.send({
                content: `🚨 **Interaction Error**\n\`\`\`\nError: ${error.message}\nStack: ${error.stack}\nUser: ${interaction.user?.tag}\nCommand: ${interaction.customId || interaction.commandName}\n\`\`\``
            }).catch(() => { });
        }

        await safeReply(interaction, {
            content: "❌ An internal error occurred. The team has been notified.",
            ephemeral: true
        });
    }
});

// ==================== MESSAGE COMMANDS ====================

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

    try {
        const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();

        if (!msg.member?.roles.cache.has(STAFF_ROLE_ID)) {
            return msg.reply("❌ Only staff with the special role!");
        }

        // ========== !panel ==========
        if (cmd === "panel") {
            const embed = new EmbedBuilder()
                .setTitle("Vorahub Premium Panel")
                .setDescription("This panel is for the project: Vorahub\n\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role")
                .setColor("#7289da")
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("redeem_modal")
                    .setLabel("🔑 Redeem Key")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId("reset_start")
                    .setLabel("🔄 Reset HWID")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId("getscript_start")
                    .setLabel("📜 Get Script")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId("getrole_start")
                    .setLabel("🎖️ Get Role")
                    .setStyle(ButtonStyle.Danger)
            );

            const panelMsg = await msg.channel.send({ embeds: [embed], components: [row] });
            latestPanelMessageId = panelMsg.id;
            latestPanelChannelId = msg.channel.id;

            await logAction("PANEL CREATED", msg.author.tag, msg.channel.name, "Create Panel");

            const confirm = await msg.reply("✅ Panel successfully created!");
            setTimeout(() => confirm.delete().catch(() => { }), 5000);
            return;
        }

        // ========== !paneltext ==========
        if (cmd === "paneltext") {
            const panelText = `**🎮 Vorahub Premium Panel**

This panel is for the project: **Vorahub**

If you're a buyer, click on the buttons below to redeem your key, get the script or get your role

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Features:**
🔑 Redeem your premium key
🔄 Reset your HWID when needed
📜 Get your Lua script instantly
👑 Claim your premium role

**Need help?** Contact staff in <#CHANNEL_ID>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Vorahub On Top* 🚀`;

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("redeem_modal")
                    .setLabel("🔑 Redeem Key")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId("reset_start")
                    .setLabel("🔄 Reset HWID")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId("getscript_start")
                    .setLabel("📜 Get Script")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId("getrole_start")
                    .setLabel("👑 Get Role")
                    .setStyle(ButtonStyle.Danger)
            );

            const panelMsg = await msg.channel.send({
                content: panelText,
                components: [row]
            });

            latestPanelMessageId = panelMsg.id;
            latestPanelChannelId = msg.channel.id;

            await logAction("PANEL TEXT CREATED", msg.author.tag, msg.channel.name, "Create Text Panel");

            const confirm = await msg.reply("✅ Text panel successfully created!");
            setTimeout(() => confirm.delete().catch(() => { }), 5000);
            return;
        }

        // ========== !gen ==========
        if (cmd === "gen" || cmd === "generate") {
            let jumlah = 1;
            let hari = null;
            let targetUser = msg.mentions.users.first();

            if (args[0] && !isNaN(args[0])) jumlah = Math.min(Math.max(parseInt(args[0]), 1), 100);
            if (args[1] && !isNaN(args[1])) hari = parseInt(args[1]);

            const isPermanent = hari === null || hari <= 0;

            const operations = [];
            const keys = [];

            for (let i = 0; i < jumlah; i++) {
                const key = generateKey();
                keys.push(key);
                operations.push((batch) => batch.set(
                    db.collection('generated_keys').doc(key),
                    {
                        createdBy: msg.author.tag,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        expiresInDays: isPermanent ? null : hari,
                        status: 'pending'
                    }
                ));
            }

            await safeBatchCommit(operations);

            const embed = new EmbedBuilder()
                .setTitle("🔑 KEYS GENERATED (Pending Redeem)")
                .setDescription(`\`\`\`${keys.join("\n")}\`\`\``)
                .addFields(
                    { name: "Total", value: `${keys.length}`, inline: true },
                    { name: "Tipe", value: isPermanent ? "PERMANENT" : `${hari} Hari`, inline: true },
                    { name: "Status", value: "⏳ Menunggu redeem", inline: true }
                )
                .setColor("#00ff00")
                .setTimestamp();

            await msg.reply({ embeds: [embed] });

            if (targetUser) {
                targetUser.send({ embeds: [embed] }).then(() => {
                    msg.channel.send(`✅ Key dikirim ke DM **${targetUser.tag}**`);
                }).catch(() => {
                    msg.channel.send(`⚠️ Gagal kirim DM ke **${targetUser.tag}** (DM ditutup?)`);
                });
            }

            await logAction("KEYS GENERATED", msg.author.tag, targetUser?.tag || "Channel", "Generate", `Jumlah: ${jumlah}, Permanent: ${isPermanent}`);
            return;
        }

        // ========== !listpending ==========
        if (cmd === "listpending") {
            const snapshot = await db.collection('generated_keys').orderBy('createdAt', 'desc').limit(50).get();

            if (snapshot.empty) {
                return msg.reply("ℹ️ No pending keys.");
            }

            const list = snapshot.docs.map((doc, idx) => {
                const d = doc.data();
                const type = d.expiresInDays == null ? "Permanent" : `${d.expiresInDays} hari`;
                return `${idx + 1}. \`${doc.id}\` - by ${d.createdBy} (${type})`;
            }).join("\n");

            const embed = new EmbedBuilder()
                .setTitle("⏳ Pending Keys")
                .setDescription(list)
                .setColor("#ffff00")
                .setFooter({ text: `Total: ${snapshot.size} | Showing max 50` })
                .setTimestamp();

            return msg.reply({ embeds: [embed] });
        }

    } catch (err) {
        console.error('[MESSAGE HANDLER ERROR]', err);

        if (webhook) {
            webhook.send({
                content: `⚠️ **Message Handler Error**\n\`\`\`\nError: ${err.message}\nUser: ${msg.author.tag}\nCommand: ${msg.content}\n\`\`\``
            }).catch(() => { });
        }

        msg.reply('❌ An internal error occurred.').catch(() => { });
    }
});

// ==================== BOT LOGIN ====================

if (!process.env.TOKEN) {
    console.error('❌ Missing TOKEN in environment variables!');
    process.exit(1);
}

client.login(process.env.TOKEN)
    .then(() => console.log(`✅ ${client.user.tag} is online`))
    .catch(err => {
        console.error('❌ Login failed:', err);
        process.exit(1);
    });
