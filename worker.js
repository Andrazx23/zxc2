require('dotenv').config();
const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: 'database.sqlite',
  logging: false
});

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
  gameId: { type: DataTypes.INTEGER },
  placeId: { type: DataTypes.INTEGER },
  usedBy: { type: DataTypes.STRING }
}, { timestamps: false });

app.get('/', (req, res) => {
  res.send("Vorahub API Online (MySQL)");
});

app.post('/redeem', async (req, res) => {
  try {
    const { key, hwid, gameId, placeId, username } = req.body;

    if (!key || !hwid) {
      return res.status(400).json({ status: "free", message: "Invalid request" });
    }

    const keyDoc = await Key.findByPk(key);

    if (!keyDoc) {
      return res.json({ status: "free", message: "Key not found" });
    }

    if (!keyDoc.isWhitelisted && keyDoc.expiresAt && new Date() > new Date(keyDoc.expiresAt)) {
      return res.json({ status: "free", message: "Key expired" });
    }

    const existingHwids = keyDoc.hwid ? keyDoc.hwid.split(',').filter(h => h) : [];

    if (keyDoc.isUsed) {
      if (existingHwids.includes(hwid)) {
        return res.json({ status: "premium", message: "Welcome back" });
      }

      if (existingHwids.length >= keyDoc.hwidLimit) {
        return res.json({
          status: "kick",
          reason: "HWID_LIMIT",
          limit: keyDoc.hwidLimit
        });
      }

      existingHwids.push(hwid);
      await Key.update({ hwid: existingHwids.join(',') }, { where: { id: key } });

      return res.json({ status: "premium", message: "New device registered" });
    }

    await Key.update({
      isUsed: true,
      usedBy: username || "unknown",
      hwid: hwid,
      gameId: gameId || 0,
      placeId: placeId || 0,
      usedAt: new Date()
    }, { where: { id: key } });

    return res.json({ status: "premium", message: "Key activated" });

  } catch (error) {
    console.error("Redeem Error:", error);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

app.listen(PORT, async () => {
  console.log(`API Server running on port ${PORT}`);
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    console.log('konekted');
  } catch (e) {
    console.error('Database error:', e);
  }
});
