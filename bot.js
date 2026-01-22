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
const PREMIUM_ROLE_ID = "1434842978932752405";
const STAFF_ROLE_ID = "1452500424551567360";
const WHITELIST_SCRIPT_LINK = "https://discord.com/channels/1434540370284384338/1434755316808941718/1452153375260020888";

// Cache configuration
const CACHE_DURATION = 300000; // 5 menit - balance antara freshness dan performance
const CACHE_SOFT_REFRESH = 60000; // 1 menit untuk background refresh
const COOLDOWN_DURATION = 3000; // 3 detik cooldown
const BATCH_LIMIT = 450; // Firestore batch limit (buffer dari 500)

// ==================== COLLECTIONS ====================
const userKeyCache = new Collection();
const cooldowns = new Collection();
const activeOperations = new Collection(); // Prevent duplicate operations
const backgroundRefreshQueue = new Set();

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
 * Generate secure key dengan format VORAHUB-XXXXXX-XXXXXX-XXXXXX
 */
function generateKey() {
    const bytes = crypto.randomBytes(9);
    return `${KEY_PREFIX}-${bytes.toString('hex').toUpperCase().match(/.{1,6}/g).join('-')}`;
}

/**
 * Validate key format
 */
function isValidKeyFormat(key) {
    const regex = new RegExp(`^${KEY_PREFIX}-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$`);
    return regex.test(key);
}

/**
 * Safe batch commit dengan split untuk large operations
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
        console.log(`[BATCH] Committed ${operations.length} operations in ${batches.length} batch(es)`);
        return batches.length;
    } catch (error) {
        console.error('[BATCH ERROR]', error);
        throw error;
    }
}

/**
 * Check if key is expired
 */
function isKeyExpired(keyData) {
    if (!keyData) return true;
    if (keyData.whitelisted) return false;
    if (keyData.expiresAt === null || keyData.expiresAt === undefined) return false;

    try {
        const expiryTime = keyData.expiresAt?.toMillis ? keyData.expiresAt.toMillis() : keyData.expiresAt;
        return expiryTime && expiryTime < Date.now();
    } catch (error) {
        console.error('[EXPIRY CHECK ERROR]', error);
        return true;
    }
}

/**
 * Background refresh user keys tanpa blocking
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
 * Refresh dan dapatkan user keys dari database
 */
async function refreshUserKeys(userId, discordTag, isBackground = false) {
    const startTime = Date.now();
    const username = discordTag.includes('#') ? discordTag.split('#')[0] : discordTag;

    try {
        // Query dengan prioritas: userId first (paling reliable)
        const [userIdSnapshot, whitelistDoc] = await Promise.all([
            db.collection('keys').where('userId', '==', userId).get(),
            db.collection('whitelist').doc(userId).get()
        ]);

        const keys = new Set();
        const updateOperations = [];
        const now = Date.now();

        // Process keys by userId
        userIdSnapshot.forEach(doc => {
            const data = doc.data();
            const keyId = doc.id;

            // Skip expired non-permanent keys
            if (!data.whitelisted && !isKeyExpired(data)) {
                keys.add(keyId);

                // Auto-update missing fields
                const updates = {};
                if (!data.usedByDiscord) updates.usedByDiscord = discordTag;
                if (Object.keys(updates).length > 0) {
                    updateOperations.push((batch) => batch.update(doc.ref, updates));
                }
            } else if (data.whitelisted || data.expiresAt === null) {
                // Permanent/whitelist key
                keys.add(keyId);
            }
        });

        // Fallback: check by discordTag if no keys found by userId
        if (keys.size === 0 && !isBackground) {
            const [tagSnapshot, usernameSnapshot] = await Promise.all([
                db.collection('keys').where('usedByDiscord', '==', discordTag).limit(5).get(),
                db.collection('keys').where('usedByDiscord', '==', username).limit(5).get()
            ]);

            [tagSnapshot, usernameSnapshot].forEach(snapshot => {
                snapshot.forEach(doc => {
                    const data = doc.data();
                    const keyId = doc.id;

                    if (keys.has(keyId)) return;

                    if (!isKeyExpired(data)) {
                        keys.add(keyId);

                        // Migrate to userId
                        const updates = {};
                        if (!data.userId) updates.userId = userId;
                        if (Object.keys(updates).length > 0) {
                            updateOperations.push((batch) => batch.update(doc.ref, updates));
                        }
                    }
                });
            });
        }

        // Process whitelist
        if (whitelistDoc.exists) {
            const whitelistData = whitelistDoc.data();
            if (whitelistData.key && !keys.has(whitelistData.key)) {
                keys.add(whitelistData.key);

                // Ensure whitelist key exists in keys collection
                const keyDoc = await db.collection('keys').doc(whitelistData.key).get();
                if (!keyDoc.exists) {
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
                } else {
                    const keyData = keyDoc.data();
                    const updates = {};
                    if (!keyData.userId) updates.userId = userId;
                    if (!keyData.usedByDiscord) updates.usedByDiscord = discordTag;
                    if (!keyData.whitelisted) updates.whitelisted = true;
                    if (Object.keys(updates).length > 0) {
                        updateOperations.push((batch) => batch.update(keyDoc.ref, updates));
                    }
                }
            }
        }

        // Commit updates if any
        if (updateOperations.length > 0) {
            await safeBatchCommit(updateOperations);
        }

        const result = Array.from(keys);
        const duration = Date.now() - startTime;

        console.log(`[KEYS ${isBackground ? 'BG' : ''}] ${discordTag} → ${result.length} keys (${duration}ms)`);

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
 * Get user active keys dengan smart caching
 */
async function getUserActiveKeys(userId, discordTag, forceRefresh = false) {
    const cached = userKeyCache.get(userId);
    const now = Date.now();

    // Force refresh
    if (forceRefresh) {
        return await refreshUserKeys(userId, discordTag);
    }

    // Cache hit dan masih valid
    if (cached && cached.expires > now) {
        // Soft refresh di background jika perlu
        if (cached.lastRefresh && (now - cached.lastRefresh) > CACHE_SOFT_REFRESH) {
            refreshUserKeysBackground(userId, discordTag).catch(() => { });
        }
        return cached.keys;
    }

    // Cache miss atau expired
    return await refreshUserKeys(userId, discordTag);
}

/**
 * Invalidate user cache dan force refresh
 */
async function invalidateUserCache(userId, discordTag) {
    userKeyCache.delete(userId);
    console.log(`[CACHE] Invalidated cache for ${discordTag}`);

    // Immediate refresh untuk ensure consistency
    try {
        await refreshUserKeys(userId, discordTag);
    } catch (error) {
        console.error(`[CACHE REFRESH ERROR] ${discordTag}:`, error.message);
    }
}

/**
 * Log action ke webhook dengan error handling
 */
async function logAction(title, executorTag, target, action, extra = "") {
    const logMessage = `[LOG] ${title} | ${executorTag} → ${target} | ${action} | ${extra}`;
    console.log(logMessage);

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
 * Safe reply dengan comprehensive error handling
 */
async function safeReply(interaction, opts) {
    try {
        const options = typeof opts === 'string' ? { content: opts, ephemeral: true } : opts;

        // Ensure ephemeral default
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
            userId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied
        });

        // Log ke webhook untuk monitoring
        if (webhook) {
            webhook.send({
                content: `⚠️ **Reply Error**\n\`\`\`\nError: ${err.message}\nUser: ${interaction.user?.tag}\nCommand: ${interaction.customId || interaction.commandName}\n\`\`\``
            }).catch(() => { });
        }

        // Last resort: try followUp
        try {
            await interaction.followUp({
                content: '⚠️ Terjadi error saat mengirim pesan. Silakan coba lagi.',
                ephemeral: true
            });
        } catch (e) {
            console.error('[FOLLOWUP ERROR]', e.message);
        }
    }
}

/**
 * Check cooldown untuk user
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
 * Set cooldown untuk user
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
        return false; // Operation already in progress
    }
    activeOperations.set(key, Date.now());
    return true;
}

function endOperation(userId, operationType) {
    const key = `${userId}-${operationType}`;
    activeOperations.delete(key);
}

// ==================== CLEANUP TASKS ====================

/**
 * Periodic cleanup untuk memory management
 */
setInterval(() => {
    const now = Date.now();
    let cleanedCooldowns = 0;
    let cleanedCache = 0;
    let cleanedOperations = 0;

    // Cleanup cooldowns
    for (const [userId, expiry] of cooldowns.entries()) {
        if (expiry < now) {
            cooldowns.delete(userId);
            cleanedCooldowns++;
        }
    }

    // Cleanup expired cache
    for (const [userId, data] of userKeyCache.entries()) {
        if (data.expires < now - (CACHE_DURATION * 2)) { // Grace period
            userKeyCache.delete(userId);
            cleanedCache++;
        }
    }

    // Cleanup stale operations (lebih dari 5 menit)
    for (const [key, timestamp] of activeOperations.entries()) {
        if (now - timestamp > 300000) {
            activeOperations.delete(key);
            cleanedOperations++;
        }
    }

    if (cleanedCooldowns > 0 || cleanedCache > 0 || cleanedOperations > 0) {
        console.log(`[CLEANUP] Cooldowns: ${cleanedCooldowns}, Cache: ${cleanedCache}, Operations: ${cleanedOperations}`);
    }

    console.log(`[MEMORY] Cooldowns: ${cooldowns.size}, Cache: ${userKeyCache.size}, Operations: ${activeOperations.size}`);
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
    console.log(`✅ Bot ${client.user.tag} is ONLINE and OPTIMIZED!`);
    console.log(`📊 Serving ${client.guilds.cache.size} guilds with ${client.users.cache.size} users`);

    client.user.setActivity('Vorahub On Top | Optimized', { type: 4 });

    // Log database stats
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
                .setTitle('🟢 Bot Online')
                .setDescription(`${client.user.tag} is now online and ready!`)
                .addFields(
                    { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
                    { name: 'Users', value: `${client.users.cache.size}`, inline: true },
                    { name: 'Status', value: '✅ Operational', inline: true },
                    { name: 'Database Keys', value: `${keysSnap.data().count}`, inline: true },
                    { name: 'Whitelist', value: `${whitelistSnap.data().count}`, inline: true },
                    { name: 'Blacklist', value: `${blacklistSnap.data().count}`, inline: true }
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

        // ==================== SLASH COMMANDS ====================

        if (interaction.isChatInputCommand()) {
            // Permission check
            if (!interaction.member?.roles.cache.has(STAFF_ROLE_ID)) {
                return safeReply(interaction, "❌ Hanya staff dengan role khusus yang dapat menggunakan command ini!");
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

                    // Check if already whitelisted
                    if ((await whitelistRef.get()).exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} sudah di whitelist!` });
                    }

                    const newKey = generateKey();
                    const operations = [];

                    // Create key in keys collection
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

                    // Add to whitelist collection
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

                    // Invalidate cache
                    await invalidateUserCache(targetUser.id, targetTag);

                    await logAction("WHITELIST ADD", interaction.user.tag, targetTag, "Whitelist Add", `Key: ${newKey}`);

                    // Auto give role
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

                    // Send notification
                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been whitelisted! You can access the script via this message -->${WHITELIST_SCRIPT_LINK}`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    return interaction.editReply({
                        content: `✅ Sukses whitelist **${targetTag}**!\n\nKey: \`${newKey}\`\nRole otomatis diberikan jika user ada di server.`
                    });
                }

                if (sub === 'remove') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const doc = await db.collection('whitelist').doc(targetUser.id).get();

                    if (!doc.exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} tidak di whitelist!` });
                    }

                    const whitelistData = doc.data();
                    const operations = [];

                    // Delete whitelist entry
                    operations.push((batch) => batch.delete(doc.ref));

                    // Delete associated key
                    if (whitelistData.key) {
                        operations.push((batch) => batch.delete(db.collection('keys').doc(whitelistData.key)));
                    }

                    await safeBatchCommit(operations);

                    // Remove role
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

                    // Send notification
                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been removed from whitelist! 💔To find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    // Invalidate cache
                    await invalidateUserCache(targetUser.id, targetTag);

                    await logAction("WHITELIST REMOVE", interaction.user.tag, targetTag, "Remove");
                    return interaction.editReply({
                        content: `✅ Berhasil hapus **${targetTag}** dari whitelist + role dihapus.`
                    });
                }

                if (sub === 'list') {
                    const snapshot = await db.collection('whitelist').orderBy('addedAt', 'desc').limit(50).get();

                    if (snapshot.empty) {
                        return interaction.editReply({ content: "ℹ️ Whitelist kosong!" });
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
                        return interaction.editReply({ content: `⚠️ ${targetTag} sudah di blacklist!` });
                    }

                    const operations = [];

                    // Add to blacklist
                    operations.push((batch) => batch.set(
                        blacklistRef,
                        {
                            userId: targetUser.id,
                            discordTag: targetTag,
                            addedBy: interaction.user.tag,
                            addedAt: admin.firestore.FieldValue.serverTimestamp()
                        }
                    ));

                    // Remove from whitelist
                    const whitelistDoc = await db.collection('whitelist').doc(targetUser.id).get();
                    if (whitelistDoc.exists) {
                        const whitelistData = whitelistDoc.data();
                        operations.push((batch) => batch.delete(whitelistDoc.ref));

                        if (whitelistData.key) {
                            operations.push((batch) => batch.delete(db.collection('keys').doc(whitelistData.key)));
                        }
                    }

                    // Delete all user keys
                    const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);
                    for (const key of userKeys) {
                        operations.push((batch) => batch.delete(db.collection('keys').doc(key)));
                    }

                    await safeBatchCommit(operations);

                    await logAction("BLACKLIST ADD", interaction.user.tag, targetTag, "Blacklist Add", `Keys deleted: ${userKeys.length}`);

                    // Remove role
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

                    // Send notification
                    try {
                        await interaction.channel.send(`<@${targetUser.id}> You have been blacklisted! 🚫To find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                    } catch (err) {
                        console.error('[NOTIFICATION ERROR]', err.message);
                    }

                    // Invalidate cache
                    await invalidateUserCache(targetUser.id, targetTag);

                    return interaction.editReply({
                        content: `✅ Sukses blacklist **${targetTag}**!\n\n${userKeys.length} key dihapus + role dihapus.`
                    });
                }

                if (sub === 'remove') {
                    const targetUser = interaction.options.getUser('user');
                    const targetTag = targetUser.tag;
                    const doc = await db.collection('blacklist').doc(targetUser.id).get();

                    if (!doc.exists) {
                        return interaction.editReply({ content: `⚠️ ${targetTag} tidak di blacklist!` });
                    }

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
                            expiresInDays: null, // Permanent
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

                // Send to user DM if specified
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

                // Get all user keys
                const userKeys = await getUserActiveKeys(targetUser.id, targetTag, true);

                if (userKeys.length === 0) {
                    return interaction.editReply({
                        content: `⚠️ **${targetTag}** tidak memiliki key aktif!`
                    });
                }

                const operations = [];

                // Delete all keys
                for (const key of userKeys) {
                    operations.push((batch) => batch.delete(db.collection('keys').doc(key)));
                }

                // Remove from whitelist
                const whitelistDoc = await db.collection('whitelist').doc(targetUser.id).get();
                if (whitelistDoc.exists) {
                    operations.push((batch) => batch.delete(whitelistDoc.ref));
                }

                await safeBatchCommit(operations);

                // Remove role
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

                // Send notification
                try {
                    await interaction.channel.send(`<@${targetUser.id}> Your keys have been removed! 💔\nTo find out why, go to\n${WHITELIST_SCRIPT_LINK} and click on **Redeem** button`);
                } catch (err) {
                    console.error('[NOTIFICATION ERROR]', err.message);
                }

                // Invalidate cache
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

                // Invalidate cache
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

                // Force refresh
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

                    // Check details for first 3 keys
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
                        value: "User tidak memiliki key aktif!",
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

                // Fetch all members with Premium role
                await interaction.guild.members.fetch();
                const premiumMembers = interaction.guild.members.cache.filter(m =>
                    m.roles.cache.has(PREMIUM_ROLE_ID) && !m.user.bot
                );

                let added = 0;
                let skipped = 0;
                const results = [];

                for (const [memberId, member] of premiumMembers) {
                    const discordTag = member.user.tag;

                    // Check if already has keys
                    const keys = await getUserActiveKeys(memberId, discordTag, true);

                    if (keys.length > 0) {
                        skipped++;
                        continue;
                    }

                    // Auto-whitelist
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

                    // Rate limit protection
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
                        value: "Semua VIP sudah punya key!",
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
                        .setTitle("📊 Bot Statistics")
                        .addFields(
                            { name: "🔑 Total Keys", value: `${keysSnap.data().count}`, inline: true },
                            { name: "✅ Whitelist", value: `${whitelistSnap.data().count}`, inline: true },
                            { name: "🚫 Blacklist", value: `${blacklistSnap.data().count}`, inline: true },
                            { name: "⏳ Pending Keys", value: `${generatedSnap.data().count}`, inline: true },
                            { name: "👥 Guilds", value: `${client.guilds.cache.size}`, inline: true },
                            { name: "💾 Cache Size", value: `${userKeyCache.size}`, inline: true },
                            { name: "⏰ Active Cooldowns", value: `${cooldowns.size}`, inline: true },
                            { name: "🔄 Active Operations", value: `${activeOperations.size}`, inline: true },
                            { name: "⏱️ Uptime", value: `<t:${Math.floor((Date.now() - client.uptime) / 1000)}:R>`, inline: true }
                        )
                        .setColor("#0099ff")
                        .setTimestamp();

                    return interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('[STATS ERROR]', error);
                    return interaction.editReply({
                        content: "❌ Gagal mengambil statistik dari database."
                    });
                }
            }
        }

        // ==================== BUTTONS & MODALS ====================

        if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
            // Cooldown check (kecuali untuk modal show)
            if (interaction.customId !== "redeem_modal") {
                const cooldownCheck = checkCooldown(userId);
                if (cooldownCheck.onCooldown) {
                    return safeReply(interaction, {
                        content: `⏰ Tunggu ${cooldownCheck.remaining} detik sebelum menggunakan fitur ini lagi!`,
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
                    .setLabel("Masukkan Key")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("VORAHUB-ABCDEF-123456-789012")
                    .setRequired(true)
                    .setMinLength(24)
                    .setMaxLength(30);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // ========== Redeem Submit ==========
            if (interaction.customId === "redeem_submit") {
                // Prevent duplicate redeem operations
                if (!startOperation(userId, 'redeem')) {
                    return safeReply(interaction, {
                        content: "⚠️ Kamu sedang melakukan redeem. Tunggu hingga selesai!",
                        ephemeral: true
                    });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });

                    // Check blacklist first
                    const blacklistDoc = await db.collection('blacklist').doc(userId).get();
                    if (blacklistDoc.exists) {
                        return safeReply(interaction, {
                            content: "❌ Kamu di-blacklist dan tidak bisa redeem key!",
                            ephemeral: true
                        });
                    }

                    const inputKey = interaction.fields.getTextInputValue('key_input').trim().toUpperCase();

                    // Validate format
                    if (!isValidKeyFormat(inputKey)) {
                        return safeReply(interaction, {
                            content: "❌ Format key salah! Harus: `VORAHUB-XXXXXX-XXXXXX-XXXXXX`",
                            ephemeral: true
                        });
                    }

                    // Check if key already used
                    const activeDoc = await db.collection('keys').doc(inputKey).get();
                    if (activeDoc.exists) {
                        const activeData = activeDoc.data();
                        return safeReply(interaction, {
                            content: `❌ Key sudah dipakai oleh **${activeData.usedByDiscord || activeData.userId || "Unknown"}**!`,
                            ephemeral: true
                        });
                    }

                    // Check if key exists in pending
                    const pendingDoc = await db.collection('generated_keys').doc(inputKey).get();
                    if (!pendingDoc.exists) {
                        return safeReply(interaction, {
                            content: "❌ Key tidak valid atau sudah kadaluarsa!",
                            ephemeral: true
                        });
                    }

                    const pendingData = pendingDoc.data();
                    const isPermanent = pendingData.expiresInDays == null;

                    const operations = [];

                    // Create key in keys collection
                    operations.push((batch) => batch.set(
                        db.collection('keys').doc(inputKey),
                        {
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
                        }
                    ));

                    // Delete from pending
                    operations.push((batch) => batch.delete(pendingDoc.ref));

                    await safeBatchCommit(operations);

                    await logAction("KEY REDEEMED", discordTag, inputKey, "Redeem Success", `Permanent: ${isPermanent}`);

                    // Auto give role
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

                    // Invalidate cache and set cooldown
                    await invalidateUserCache(userId, discordTag);
                    setCooldown(userId);

                    return safeReply(interaction, {
                        content: `✅ Key \`${inputKey}\` berhasil diredeem!\n\n🎉 Kamu sekarang bisa pakai semua fitur panel.\n👑 Role Premium otomatis diberikan jika kamu di server.`,
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
                            content: "❌ Fitur ini hanya bisa dipakai di server.",
                            ephemeral: true
                        });
                    }

                    // Check if user has active keys
                    const keys = await getUserActiveKeys(userId, discordTag, true);
                    if (keys.length === 0) {
                        return safeReply(interaction, {
                            content: "❌ Kamu belum punya key aktif! Silakan redeem key terlebih dahulu.",
                            ephemeral: true
                        });
                    }

                    const member = await interaction.guild.members.fetch(userId).catch(() => null);
                    if (!member) {
                        return safeReply(interaction, {
                            content: "❌ Gagal menemukan member di server.",
                            ephemeral: true
                        });
                    }

                    if (member.roles.cache.has(PREMIUM_ROLE_ID)) {
                        return safeReply(interaction, {
                            content: "✅ Kamu sudah punya role Premium!",
                            ephemeral: true
                        });
                    }

                    await member.roles.add(PREMIUM_ROLE_ID);
                    await logAction("ROLE MANUAL", discordTag, "Premium", "Manual Get Role");
                    setCooldown(userId);

                    return safeReply(interaction, {
                        content: "✅ Role Premium berhasil diberikan!",
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
                            content: "❌ Kamu belum punya key aktif! Silakan redeem key atau whitelist terlebih dahulu.",
                            ephemeral: true
                        });
                    }

                    // If only one key, show script directly
                    if (keys.length === 1) {
                        const script = `_G.script_key = "${keys[0]}"\nloadstring(game:HttpGet("${SCRIPT_URL}"))()`;
                        await logAction("SCRIPT GET", discordTag, keys[0], "Get Script");
                        setCooldown(userId);

                        return safeReply(interaction, {
                            content: "**Your Script:**\n```lua\n" + script + "\n```",
                            ephemeral: true
                        });
                    }

                    // Multiple keys - show select menu
                    const select = new StringSelectMenuBuilder()
                        .setCustomId("getscript_select")
                        .setPlaceholder("Pilih key untuk get script")
                        .addOptions(keys.map(k => ({
                            label: k.substring(0, 25),
                            description: k.substring(25) || "...",
                            value: k
                        })));

                    return safeReply(interaction, {
                        content: `📝 Kamu punya **${keys.length}** key. Pilih satu untuk get script:`,
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
                            content: "❌ Kamu belum punya key aktif!",
                            ephemeral: true
                        });
                    }

                    // If only one key, reset directly
                    if (keys.length === 1) {
                        await db.collection('keys').doc(keys[0]).update({
                            hwid: "",
                            used: false
                        });

                        await logAction("HWID RESET", discordTag, keys[0], "Reset HWID");
                        setCooldown(userId);

                        return safeReply(interaction, {
                            content: `✅ HWID untuk key \`${keys[0]}\` telah direset.`,
                            ephemeral: true
                        });
                    }

                    // Multiple keys - ask user
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("reset_all_confirm")
                            .setLabel("Reset Semua HWID")
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId("reset_choose_key")
                            .setLabel("Pilih Key Tertentu")
                            .setStyle(ButtonStyle.Primary)
                    );

                    return safeReply(interaction, {
                        content: `🔑 Kamu punya **${keys.length}** key aktif.\nMau reset HWID semua key atau pilih satu?`,
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
                    content: `✅ HWID untuk **${keys.length}** key telah direset semua!`,
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
                    .setPlaceholder("Pilih key untuk reset HWID")
                    .addOptions(keys.map(k => ({
                        label: k.substring(0, 25),
                        description: k.substring(25) || "...",
                        value: k
                    })));

                return safeReply(interaction, {
                    content: "🔑 Pilih key yang ingin direset HWID-nya:",
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
                    content: `✅ HWID untuk key \`${key}\` telah direset.`,
                    ephemeral: true
                });
            }
        }

    } catch (error) {
        console.error('[INTERACTION ERROR]', error);

        // Log to webhook
        if (webhook) {
            webhook.send({
                content: `🚨 **Interaction Error**\n\`\`\`\nError: ${error.message}\nStack: ${error.stack}\nUser: ${interaction.user?.tag}\nCommand: ${interaction.customId || interaction.commandName}\n\`\`\``
            }).catch(() => { });
        }

        await safeReply(interaction, {
            content: "❌ Terjadi error internal. Tim telah diberitahu.",
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

        // Permission check
        if (!msg.member?.roles.cache.has(STAFF_ROLE_ID)) {
            return msg.reply("❌ Hanya staff dengan role khusus!");
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

            const confirm = await msg.reply("✅ Panel berhasil dibuat!");
            setTimeout(() => confirm.delete().catch(() => { }), 5000);
            return;
        }

        // ========== !paneltext (Copy-Paste Ready) ==========
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

            const confirm = await msg.reply("✅ Panel text berhasil dibuat!");
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
                return msg.reply("ℹ️ Tidak ada key pending.");
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

        msg.reply('❌ Terjadi error internal.').catch(() => { });
    }
});

// ==================== BOT LOGIN ====================

if (!process.env.TOKEN) {
    console.error('❌ Missing TOKEN in environment variables!');
    console.error('Please set TOKEN in your .env file');
    process.exit(1);
} else {
    client.login(process.env.TOKEN)
        .then(() => {
            console.log('🔐 Successfully logged in to Discord!');
        })
        .catch(err => {
            console.error('❌ Login failed:', err);
            process.exit(1);
        });
}
