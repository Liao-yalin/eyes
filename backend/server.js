// server.js — 啟動方式：node server.js
// 需要安裝：npm install express cors firebase-admin dotenv

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const path    = require('path');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db  = admin.database();
const app = express();
app.use(cors({ origin: 'http://localhost:3000' })); // 部署時改為你的網域
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 前端靜態檔案

// ── API 路由 ──────────────────────────────────────────────

// 讀取指定影片的標註
app.get('/api/annotations/:videoKey', async (req, res) => {
  try {
    const snap = await db.ref(`video_annotations/${req.params.videoKey}`).get();
    res.json(snap.exists() ? snap.val() : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 儲存（覆寫）指定影片的標註
app.post('/api/annotations/:videoKey', async (req, res) => {
  try {
    const zones = req.body;
    if (!Array.isArray(zones)) return res.status(400).json({ error: 'body 必須是陣列' });
    await db.ref(`video_annotations/${req.params.videoKey}`).set(zones);
    res.json({ ok: true, count: zones.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 刪除指定影片的全部標註
app.delete('/api/annotations/:videoKey', async (req, res) => {
  try {
    await db.ref(`video_annotations/${req.params.videoKey}`).remove();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 學生紀錄（index.html / basis.html 用）─────────────────

// 儲存學生觀看紀錄
// dbPath = "student_logs" | "control_logs"
app.post('/api/logs/:dbPath/:studentId', async (req, res) => {
  try {
    const { dbPath, studentId } = req.params;
    // 只允許合法的 DB 路徑，防止任意寫入
    const ALLOWED_PATHS = ['student_logs', 'control_logs'];
    if (!ALLOWED_PATHS.includes(dbPath))
      return res.status(400).json({ error: '不合法的 dbPath' });
    await db.ref(`${dbPath}/${studentId}/test_video_01`).set(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`伺服器啟動：http://localhost:${PORT}`));
