import discord
from discord import app_commands
from discord.ext import commands
import os

# ==============================
# KONFIGURASI
# ==============================
BOT_TOKEN = os.getenv("BOT_TOKEN")
GUILD_ID = 1414219665428844606  # ID server untuk sync cepat

# Role & user yang boleh pakai bot
ALLOWED_ROLE_ID = 1428635556249604117
ALLOWED_USER_ID = 893729892951289858

# ==============================
# SETUP BOT
# ==============================
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)


# ==============================
# EVENT: BOT ONLINE
# ==============================
@bot.event
async def on_ready():
    print(f"✅ Bot {bot.user} sudah online!")
    try:
        guild = discord.Object(id=GUILD_ID)
        synced = await bot.tree.sync(guild=guild)
        print(f"🔁 {len(synced)} command di-sync ke guild {GUILD_ID}:")
        for cmd in synced:
            print(f"   • /{cmd.name}")
        print("📋 Semua command aktif dan siap digunakan!")
    except Exception as e:
        print(f"❌ Gagal sync commands: {e}")


# ==============================
# CEK IZIN AKSES
# ==============================
def is_allowed(user: discord.Member):
    """Cek apakah user punya role atau ID yang diizinkan."""
    has_role = any(role.id == ALLOWED_ROLE_ID for role in user.roles)
    return has_role or user.id == ALLOWED_USER_ID


# ==============================
# /text → kirim teks biasa
# ==============================
@bot.tree.command(name="text", description="Kirim teks bebas lewat bot")
@app_commands.describe(content="Isi teks yang ingin dikirim")
@app_commands.guilds(discord.Object(id=GUILD_ID))
async def text(interaction: discord.Interaction, content: str):
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "🚫 Kamu tidak diizinkan memakai bot ini.", ephemeral=True)
        return

    if not content.strip():
        await interaction.response.send_message("⚠️ Teks tidak boleh kosong!",
                                                ephemeral=True)
        return

    await interaction.response.send_message("✅ Pesan dikirim!", ephemeral=True)
    await interaction.channel.send(content)
    print(f"[LOG] /text oleh {interaction.user} -> {content}")


# ==============================
# /textembed → kirim embed teks (opsional gambar)
# ==============================
@bot.tree.command(
    name="textembed",
    description="Kirim embed dengan teks dan (opsional) file gambar/GIF")
@app_commands.describe(title="Judul embed",
                       description="Isi teks embed",
                       color="Warna embed hex tanpa # (contoh: FF0000)",
                       attachment="(Opsional) File gambar/GIF untuk embed")
@app_commands.guilds(discord.Object(id=GUILD_ID))
async def textembed(interaction: discord.Interaction,
                    title: str,
                    description: str,
                    color: str = "5865F2",
                    attachment: discord.Attachment = None):
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "🚫 Kamu tidak diizinkan memakai bot ini.", ephemeral=True)
        return

    # Validasi warna
    try:
        color_value = int(color, 16)
    except ValueError:
        await interaction.response.send_message(
            "❌ Warna salah! Gunakan format hex tanpa #.", ephemeral=True)
        return

    embed = discord.Embed(title=title,
                          description=description,
                          color=color_value)
    embed.set_footer(text="Sent by Seraphin")

    await interaction.response.defer(ephemeral=True)

    try:
        if attachment:
            file = await attachment.to_file()
            embed.set_image(url=f"attachment://{file.filename}")
            await interaction.channel.send(embed=embed, file=file)
            await interaction.followup.send(
                "✅ Embed dengan gambar berhasil dikirim!", ephemeral=True)
            print(
                f"[LOG] /textembed oleh {interaction.user} -> {attachment.filename}"
            )
        else:
            await interaction.channel.send(embed=embed)
            await interaction.followup.send(
                "✅ Embed tanpa gambar berhasil dikirim!", ephemeral=True)
            print(f"[LOG] /textembed oleh {interaction.user} -> (tanpa file)")
    except Exception as e:
        await interaction.followup.send(f"❌ Gagal kirim embed: {e}",
                                        ephemeral=True)


# ==============================
# /fileembed → kirim hanya file gambar/GIF dalam embed
# ==============================
@bot.tree.command(
    name="fileembed",
    description="Kirim hanya file gambar/GIF dalam embed (tanpa teks)")
@app_commands.describe(attachment="File gambar/GIF yang ingin dikirim")
@app_commands.guilds(discord.Object(id=GUILD_ID))
async def fileembed(interaction: discord.Interaction,
                    attachment: discord.Attachment):
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "🚫 Kamu tidak diizinkan memakai bot ini.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    try:
        file = await attachment.to_file()
        embed = discord.Embed(color=0x5865F2)
        embed.set_image(url=f"attachment://{file.filename}")
        embed.set_footer(text="Sent by Seraphin")

        await interaction.channel.send(embed=embed, file=file)
        await interaction.followup.send("✅ File embed berhasil dikirim!",
                                        ephemeral=True)
        print(
            f"[LOG] /fileembed oleh {interaction.user} -> {attachment.filename}"
        )
    except Exception as e:
        await interaction.followup.send(f"❌ Gagal kirim file embed: {e}",
                                        ephemeral=True)


# ==============================
# /dm → kirim pesan ke user (mention)
# ==============================
@bot.tree.command(name="dm",
                  description="Kirim pesan ke DM user tertentu (mention)")
@app_commands.describe(user="User yang ingin dikirimi pesan",
                       message="Isi pesan yang ingin dikirim ke DM")
@app_commands.guilds(discord.Object(id=GUILD_ID))
async def dm(interaction: discord.Interaction, user: discord.User,
             message: str):
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "🚫 Kamu tidak diizinkan memakai bot ini.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)
    try:
        await user.send(message)
        await interaction.followup.send(
            f"✅ Pesan berhasil dikirim ke {user.mention}!", ephemeral=True)
        print(f"[LOG] /dm oleh {interaction.user} -> {user} : {message}")
    except discord.Forbidden:
        await interaction.followup.send(
            "❌ Gagal kirim DM — user menonaktifkan pesan langsung.",
            ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"❌ Gagal kirim DM: {e}",
                                        ephemeral=True)


# ==============================
# /dmid → kirim pesan via ID
# ==============================
@bot.tree.command(name="dmid",
                  description="Kirim pesan ke DM user berdasarkan ID Discord")
@app_commands.describe(user_id="ID Discord user (contoh: 893729892951289858)",
                       message="Isi pesan yang ingin dikirim ke DM")
@app_commands.guilds(discord.Object(id=GUILD_ID))
async def dmid(interaction: discord.Interaction, user_id: str, message: str):
    if not is_allowed(interaction.user):
        await interaction.response.send_message(
            "🚫 Kamu tidak diizinkan memakai bot ini.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)
    try:
        user = await bot.fetch_user(int(user_id))
        await user.send(message)
        await interaction.followup.send(
            f"✅ Pesan berhasil dikirim ke **{user}** (`{user.id}`)!",
            ephemeral=True)
        print(f"[LOG] /dmid oleh {interaction.user} -> {user} : {message}")
    except discord.NotFound:
        await interaction.followup.send(
            "❌ User dengan ID itu tidak ditemukan.", ephemeral=True)
    except discord.Forbidden:
        await interaction.followup.send(
            "❌ Gagal kirim DM — user menonaktifkan DM atau tidak berbagi server.",
            ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"❌ Terjadi error: {e}",
                                        ephemeral=True)


# ==============================
# JALANKAN BOT
# ==============================
if __name__ == "__main__":
    bot.run(BOT_TOKEN)
