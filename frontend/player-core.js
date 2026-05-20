const CFG = window.GROUP_CONFIG;

const API_BASE    = 'http://localhost:3000/api';
const CAM_W       = 320, CAM_H = 240;
const EPOCHS      = CFG.epochs;
const CONF        = 0.5;
const INFER_MS    = 33;
const ZONE_FADE_MS = 1500;

// ── DOM 參照 ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const contentVideo   = $('content-video');
const canvas         = $('overlay-canvas');
const ctx            = canvas.getContext('2d');
const statusEl       = $('status');
const centerMsgEl    = $('center-msg');
const dot            = $('calibration-dot');
const cursor         = $('eye-cursor');
const videoContainer = $('video-container');
const videoWrapper   = $('video-wrapper');
const videoInput     = $('video-input');
const btnPlay        = $('btn-play-pause');
const controls       = $('custom-controls');

// ── 狀態變數 ──────────────────────────────────────────────────
let studentId = "", remoteZones = [];
let faceMesh, regressor;
let sX = .5, sY = .5;
let videoRect = null;
let isLearningStarted = false, isCalibrating = false, isManuallyPaused = true;
let currentFeatures = null, lastInferTs = 0;
let trainingData = { inputs: [], outputs: [] };
let pIdx = 0;
let gazeBuffer = [], eventLog = [];
let stats = {
  組別            : CFG.groupName,
  螢幕解析度      : `${window.innerWidth}x${window.innerHeight}`,
  重新校正次數    : 0, 分頁切換次數: 0, 視線移開次數: 0,
  手動暫停次數    : 0, 全螢幕切換次數: 0, 倍速切換次數: 0,
  人臉消失次數    : 0, 實驗開始時間: "", 影片是否看完: false
};
let playStartTs = null, effectiveWatchMs = 0;
let zoneGazeSeconds = {}, zoneGazeStart = null, currentZoneLabel = null;
let wasLookingAway = false, lookAwayStart = null;
let faceDisappearStart = null;
let isSyncing = false, autoSaveTimer = null;
let isCalibrationFullscreen = false;
let zoneHintTimers = {};
let statusTimer = null;

function showStatus(text, duration = 3000) {
  clearTimeout(statusTimer);
  statusEl.innerText = text;
  statusEl.style.opacity = '1';
  if (duration > 0) statusTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, duration);
}
function showCenterMsg(text) { centerMsgEl.innerText = text; centerMsgEl.style.display = 'block'; }
function hideCenterMsg()     { centerMsgEl.style.display = 'none'; }

let uiTimer = null;
function showControls() {
  controls.style.opacity = '1';
  controls.style.pointerEvents = 'auto';
  if (isLearningStarted && !isCalibrating) contentVideo.style.cursor = 'default';
  clearTimeout(uiTimer);
  if (!contentVideo.paused) uiTimer = setTimeout(hideControls, 3000);
}
function hideControls() {
  if (!contentVideo.paused && !isCalibrating) {
    controls.style.opacity = '0';
    controls.style.pointerEvents = 'none';
    contentVideo.style.cursor = 'none';
  }
}
window.addEventListener('mousemove', showControls);
videoContainer.addEventListener('mousemove', showControls);

function updateVideoRect() {
  videoRect = contentVideo.getBoundingClientRect();
  canvas.width  = contentVideo.clientWidth;
  canvas.height = contentVideo.clientHeight;
}
window.addEventListener('resize', updateVideoRect);

contentVideo.addEventListener('play',  () => { playStartTs = Date.now(); });
contentVideo.addEventListener('pause', () => {
  if (playStartTs) { effectiveWatchMs += Date.now() - playStartTs; playStartTs = null; }
});


const LS_KEY = () => `eyetrack_${CFG.dbPath}_${studentId}_${CFG.videoKey}`;

function buildPayload(reason) {
  const now = Date.now();
  let ms = effectiveWatchMs + (playStartTs ? now - playStartTs : 0);
  const zoneSec = { ...zoneGazeSeconds };
  if (currentZoneLabel && zoneGazeStart)
    zoneSec[currentZoneLabel] = +( ((zoneSec[currentZoneLabel]||0)+(now-zoneGazeStart)/1000).toFixed(2) );
  return {
    詳細軌跡紀錄 : [...gazeBuffer],
    事件時間軸   : [...eventLog],
    注意力統計摘要: {
      ...stats,
      最後同步時間 : new Date().toLocaleString(), 同步原因: reason,
      總採樣點數   : gazeBuffer.length,
      實際有效觀看秒數: +(ms/1000).toFixed(1),
      各Zone注視秒數  : zoneSec
    }
  };
}
function saveToLocal(reason) {
  if (!studentId) return;
  try { const p = buildPayload(reason); p._pendingUpload = true; localStorage.setItem(LS_KEY(), JSON.stringify(p)); } catch(e) {}
}
function clearLocal() { try { localStorage.removeItem(LS_KEY()); } catch(e) {} }

async function uploadPending() {
  try {
    const raw = localStorage.getItem(LS_KEY());
    if (!raw) return;
    const p = JSON.parse(raw);
    if (!p._pendingUpload) return;
    showStatus("偵測到未上傳紀錄，補傳中...", 0);
    delete p._pendingUpload;
    p.注意力統計摘要.同步原因 = "重新開啟頁面後補傳";
    const res = await fetch(`${API_BASE}/logs/${CFG.dbPath}/${encodeURIComponent(studentId)}/${encodeURIComponent(CFG.videoKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    clearLocal(); showStatus("補傳成功！");
  } catch(e) { showStatus("補傳失敗：" + e.message); }
}

async function syncData(reason) {
  if (!studentId || (!gazeBuffer.length && !eventLog.length) || isSyncing) return;
  isSyncing = true;
  showStatus("同步數據中...", 0);
  try {
    const res = await fetch(`${API_BASE}/logs/${CFG.dbPath}/${encodeURIComponent(studentId)}/${encodeURIComponent(CFG.videoKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload(reason))
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus("數據已同步"); clearLocal();
  } catch(e) {
    showStatus("網路失敗，已保留本機備份"); saveToLocal(reason);
  }
  isSyncing = false;
}

function startAutoSave() {
  clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    if (isLearningStarted && !isCalibrating) { saveToLocal("定時存檔"); syncData("定時自動存檔"); }
  }, 30000);
}


window.addEventListener('beforeunload',       () => { if (isLearningStarted) saveToLocal("頁面關閉"); });
window.addEventListener('pagehide',           () => { if (isLearningStarted) saveToLocal("pagehide"); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    forceSystemPause("已離開分頁");
    if (isLearningStarted) { saveToLocal("分頁切換"); syncData("分頁切換"); }
  } else if (isManuallyPaused && isLearningStarted) {
    showStatus(CFG.resumeMsg);
  }
});
window.addEventListener('blur',  () => forceSystemPause("偵測到操作其他視窗"));
window.addEventListener('focus', () => { if (isManuallyPaused && isLearningStarted) showStatus(CFG.resumeMsg); });


async function fetchZones() {
  try {
    const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(CFG.videoKey)}`);
    if (res.ok) remoteZones = await res.json();
  } catch(e) {}
}


function predictGaze(features) {
  tf.tidy(() => {
    const pred = regressor.predict(tf.tensor2d([features])).dataSync();
    const rawX = (pred[0]-.5)*1.4+.5, rawY = (pred[1]-.5)*1.4+.5;
    const a = Math.hypot(rawX-sX, rawY-sY) > .1 ? .6 : .15;
    sX = sX*(1-a)+rawX*a; sY = sY*(1-a)+rawY*a;
    cursor.style.left = sX * videoContainer.clientWidth  + 'px';
    cursor.style.top  = sY * videoContainer.clientHeight + 'px';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now  = Date.now();
    const zone = remoteZones.find(z =>
      contentVideo.currentTime >= z.startTime && contentVideo.currentTime <= z.endTime
    );

    let canPlay = true;

    if (zone) {
      const inZone = sX >= zone.xMin && sX <= zone.xMax && sY >= zone.yMin && sY <= zone.yMax;
      const key    = `${zone.label}_${zone.startTime}`;

      if (inZone) {
        if (currentZoneLabel !== zone.label) {
          if (currentZoneLabel && zoneGazeStart)
            zoneGazeSeconds[currentZoneLabel] = +( ((zoneGazeSeconds[currentZoneLabel]||0)+(now-zoneGazeStart)/1000).toFixed(2) );
          currentZoneLabel = zone.label; zoneGazeStart = now;
        }
        delete zoneHintTimers[key];
        canPlay = true;
      } else {
        if (currentZoneLabel && zoneGazeStart) {
          zoneGazeSeconds[currentZoneLabel] = +( ((zoneGazeSeconds[currentZoneLabel]||0)+(now-zoneGazeStart)/1000).toFixed(2) );
          currentZoneLabel = null; zoneGazeStart = null;
        }
        canPlay = !CFG.enforceGaze;

        if (CFG.enforceGaze) {
          const bx = zone.xMin*canvas.width,  by = zone.yMin*canvas.height;
          const bw = (zone.xMax-zone.xMin)*canvas.width, bh = (zone.yMax-zone.yMin)*canvas.height;
          ctx.strokeStyle = "#ff4757"; ctx.lineWidth = 4; ctx.setLineDash([10,5]);
          ctx.strokeRect(bx, by, bw, bh);
          ctx.fillStyle = "rgba(255,71,87,.18)"; ctx.fillRect(bx, by, bw, bh);
          ctx.font = `bold ${Math.max(18,Math.min(bw/6,36))}px sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 8;
          ctx.fillStyle = "#fff"; ctx.fillText(zone.label||"這是重點", bx+bw/2, by+bh/2);
          ctx.shadowBlur = 0; ctx.setLineDash([]);
        } else {
          if (zoneHintTimers[key] === undefined) zoneHintTimers[key] = now;
          const elapsed = now - zoneHintTimers[key];
          if (elapsed < ZONE_FADE_MS) {
            const alpha = 1 - elapsed / ZONE_FADE_MS;
            const bx = zone.xMin*canvas.width, by = zone.yMin*canvas.height;
            const bw = (zone.xMax-zone.xMin)*canvas.width, bh = (zone.yMax-zone.yMin)*canvas.height;
            ctx.save(); ctx.globalAlpha = alpha;
            ctx.strokeStyle = "#ff4757"; ctx.lineWidth = 4; ctx.setLineDash([10,5]);
            ctx.strokeRect(bx, by, bw, bh);
            ctx.fillStyle = "rgba(255,71,87,.15)"; ctx.fillRect(bx, by, bw, bh);
            ctx.restore(); ctx.setLineDash([]);
          }
        }
      }
    } else {
      if (currentZoneLabel && zoneGazeStart) {
        zoneGazeSeconds[currentZoneLabel] = +( ((zoneGazeSeconds[currentZoneLabel]||0)+(now-zoneGazeStart)/1000).toFixed(2) );
        currentZoneLabel = null; zoneGazeStart = null;
      }
      if (!videoRect) updateVideoRect();
      const inVideo = sX * videoContainer.clientWidth >= videoRect.left-30 &&
                      sX * videoContainer.clientWidth <= videoRect.right+30;

      if (CFG.enforceGaze) {
        canPlay = inVideo;
        if (!canPlay) {
          ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = "bold 32px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 12;
          ctx.fillStyle = "#fff"; ctx.fillText("請看著影片以繼續播放", canvas.width/2, canvas.height/2);
          ctx.shadowBlur = 0;
        }
      } else {
        canPlay = true;
        if (!inVideo && !wasLookingAway && !contentVideo.paused) {
          stats.視線移開次數++; wasLookingAway = true; lookAwayStart = now;
        } else if (inVideo && wasLookingAway) {
          eventLog.push({ 事件:"視線移開", 影片秒數:+contentVideo.currentTime.toFixed(2), 持續秒數:+((now-lookAwayStart)/1000).toFixed(2) });
          wasLookingAway = false; lookAwayStart = null;
        }
        if (!contentVideo.paused)
          gazeBuffer.push({ 秒數:+contentVideo.currentTime.toFixed(2), 視線X:+sX.toFixed(3), 視線Y:+sY.toFixed(3), 區域:zone?.label||"一般", 視線在影片內:inVideo });
        return;
      }
    }

    if (CFG.enforceGaze) {
      if (!canPlay && !wasLookingAway && !contentVideo.paused) {
        stats.視線移開次數++; wasLookingAway = true; lookAwayStart = now;
      } else if (canPlay && wasLookingAway) {
        eventLog.push({ 事件:"視線移開", 影片秒數:+contentVideo.currentTime.toFixed(2), 持續秒數:+((now-lookAwayStart)/1000).toFixed(2) });
        wasLookingAway = false; lookAwayStart = null;
      }
      if (canPlay) { if (!isManuallyPaused && contentVideo.paused) { contentVideo.play().catch(()=>{}); hideControls(); } }
      else if (!contentVideo.paused) { contentVideo.pause(); showControls(); }
    }

    if (!contentVideo.paused)
      gazeBuffer.push({ 秒數:+contentVideo.currentTime.toFixed(2), 視線X:+sX.toFixed(3), 視線Y:+sY.toFixed(3), 區域:zone?.label||"一般" });
  });
}

function togglePlay() {
  if (!isLearningStarted) return;
  if (contentVideo.paused) {
    contentVideo.play().catch(()=>{}); btnPlay.innerText = "暫停"; isManuallyPaused = false; hideControls();
  } else {
    contentVideo.pause(); btnPlay.innerText = "播放"; isManuallyPaused = true;
    stats.手動暫停次數++;
    eventLog.push({ 事件:"手動暫停", 影片秒數:+contentVideo.currentTime.toFixed(2) });
    showControls();
  }
}
function triggerRecalibrate() {
  contentVideo.pause(); isManuallyPaused = true; isLearningStarted = false;
  stats.重新校正次數++;
  eventLog.push({ 事件:"重新校正", 影片秒數:+contentVideo.currentTime.toFixed(2) });
  cursor.style.display = 'none'; videoWrapper.style.opacity = '0';
  btnPlay.innerText = "播放"; showControls(); startCalibration();
}
function forceSystemPause(reason) {
  if (!isLearningStarted || isCalibrating) return;
  stats.分頁切換次數++;
  contentVideo.pause(); isManuallyPaused = true; btnPlay.innerText = "播放";
  showStatus(`${reason}：已暫停`); showControls();
}
contentVideo.onended = async () => {
  stats.影片是否看完 = true;
  contentVideo.currentTime = 0; contentVideo.pause(); btnPlay.innerText = "播放";
  isManuallyPaused = true; showControls();
  await syncData("影片播放完畢");
  clearLocal(); gazeBuffer = []; eventLog = [];
};

$('speed-select').onchange = e => {
  const sp = parseFloat(e.target.value); contentVideo.playbackRate = sp;
  stats.倍速切換次數++;
  eventLog.push({ 事件:"倍速切換", 影片秒數:+contentVideo.currentTime.toFixed(2), 倍速:sp });
};
document.addEventListener('fullscreenchange', () => {
  showControls();
  if (isCalibrationFullscreen) { isCalibrationFullscreen = false; return; }
  if (!isLearningStarted) return;
  stats.全螢幕切換次數++;
  eventLog.push({ 事件: document.fullscreenElement?"全螢幕開啟":"全螢幕關閉", 影片秒數:+contentVideo.currentTime.toFixed(2) });
});
contentVideo.ontimeupdate = () => {
  $('progress-bar').style.width = contentVideo.currentTime / contentVideo.duration * 100 + "%";
  const m = Math.floor(contentVideo.currentTime/60), sec = Math.floor(contentVideo.currentTime%60);
  $('time-txt').innerText = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};
window.addEventListener('keydown', e => { if (e.code === "Space") { e.preventDefault(); togglePlay(); } });
$('btn-play-pause').addEventListener('pointerdown',  e => { e.stopPropagation(); togglePlay(); });
$('btn-recalibrate').addEventListener('pointerdown', e => { e.stopPropagation(); triggerRecalibrate(); });
$('btn-fullscreen').addEventListener('pointerdown',  e => { e.stopPropagation(); document.fullscreenElement ? document.exitFullscreen() : videoContainer.requestFullscreen(); });

const CAL_POINTS = [
  {x:.05,y:.05},{x:.5,y:.05},{x:.95,y:.05},
  {x:.05,y:.5}, {x:.5,y:.5}, {x:.95,y:.5},
  {x:.05,y:.95},{x:.5,y:.95},{x:.95,y:.95}
];
function startCalibration() {
  isCalibrating = true; pIdx = 0; trainingData = { inputs: [], outputs: [] };
  document.body.classList.add('calibrating');
  hideCenterMsg(); videoWrapper.style.opacity = '0'; cursor.style.display = 'none';
  showControls(); showCalDot();
}
function showCalDot() {
  if (pIdx >= CAL_POINTS.length) { trainModel(); return; }
  const p = CAL_POINTS[pIdx];
  dot.style.display = 'block';
  dot.style.background = '#ff4757';
  dot.style.left = p.x * videoContainer.clientWidth  + 'px';
  dot.style.top  = p.y * videoContainer.clientHeight + 'px';
  dot.onpointerdown = async e => {
    e.stopPropagation();
    if (!currentFeatures) return;
    dot.onpointerdown = null;

    dot.style.background = '#ffa502';
    showStatus('請保持注視紅點…', 0);

    const samples = [];
    await new Promise(resolve => {
      const iv = setInterval(() => {
        if (currentFeatures) samples.push([...currentFeatures]);
        if (samples.length >= 20) { clearInterval(iv); resolve(); }
      }, 33);
    });
    const avg = samples[0].map((_, dim) =>
      samples.reduce((sum, row) => sum + row[dim], 0) / samples.length
    );
    trainingData.inputs.push(avg);
    trainingData.outputs.push([p.x, p.y]);

    pIdx++; showCalDot();
  };
}
async function trainModel() {
  dot.style.display = 'none';
  showStatus("訓練中... 0%", 0);
  regressor = tf.sequential();
  regressor.add(tf.layers.dense({ units: 64, activation: 'tanh', inputShape: [6] }));  // 6維特徵
  regressor.add(tf.layers.dense({ units: 32, activation: 'tanh' }));
  regressor.add(tf.layers.dense({ units: 2 }));
  regressor.compile({ optimizer: tf.train.adam(.005), loss: 'meanSquaredError' });
  await regressor.fit(
    tf.tensor2d(trainingData.inputs), tf.tensor2d(trainingData.outputs),
    { epochs: EPOCHS, callbacks: { onEpochEnd: ep => showStatus(`訓練中... ${Math.round((ep+1)/EPOCHS*100)}%`, 0) } }
  );
  document.body.classList.remove('calibrating');
  isCalibrating = false; isLearningStarted = true; isManuallyPaused = true;
  stats.實驗開始時間 = new Date().toLocaleString();
  zoneGazeSeconds = {}; zoneGazeStart = null; currentZoneLabel = null;
  wasLookingAway = false; lookAwayStart = null; zoneHintTimers = {};
  if (document.fullscreenElement) { isCalibrationFullscreen = true; document.exitFullscreen().catch(() => {}); }
  videoWrapper.style.opacity = '1'; btnPlay.innerText = "播放";
  showCenterMsg("校正完成\n請點擊「播放」開始觀看");
  setTimeout(hideCenterMsg, 2500);
  cursor.style.display = 'block'; updateVideoRect(); showControls(); startAutoSave();
  showStatus("校正完成");
}

function extractFeatures(lm) {

  const eyeRel = (ir, t, b, i, o) => {
    const [I, T, B, In, O] = [lm[ir], lm[t], lm[b], lm[i], lm[o]];
    return I ? [(I.x-O.x)/(In.x-O.x), (I.y-T.y)/(B.y-T.y)] : [.5,.5];
  };
  const iris = [...eyeRel(468,159,145,133,33), ...eyeRel(473,386,374,362,263)].map(v => v*2);
  const faceW   = Math.abs(lm[234].x - lm[454].x) || 1;
  const midX    = (lm[234].x + lm[454].x) / 2;
  const headYaw = (lm[1].x - midX) / faceW;

  const faceH     = Math.abs(lm[10].y - lm[152].y) || 1;
  const midY      = (lm[10].y + lm[152].y) / 2;
  const headPitch = (lm[1].y - midY) / faceH;

  return [...iris, headYaw, headPitch];
}

function onFaceResults(results) {
  if (!results.multiFaceLandmarks?.length) {
    currentFeatures = null;
    if (!faceDisappearStart) { faceDisappearStart = Date.now(); stats.人臉消失次數++; }
    if (isLearningStarted) {
      showStatus("偵測不到人臉", 0);
      if (CFG.enforceGaze && !contentVideo.paused) contentVideo.pause();
    }
    return;
  }
  if (faceDisappearStart) {
    eventLog.push({ 事件:"人臉消失", 影片秒數:+contentVideo.currentTime.toFixed(2), 持續秒數:+((Date.now()-faceDisappearStart)/1000).toFixed(2) });
    faceDisappearStart = null;
  }
  const lm = results.multiFaceLandmarks[0];
  currentFeatures = extractFeatures(lm);
  if (regressor && !isCalibrating) {
    const now = Date.now();
    if (now - lastInferTs >= INFER_MS) { lastInferTs = now; predictGaze(currentFeatures); }
  }
}

async function init() {
  try { await tf.setBackend('webgl'); } catch(e) { await tf.setBackend('cpu'); }

  studentId = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';
    overlay.innerHTML = `
      <div style="background:#1a1a1a;padding:32px;border-radius:12px;width:320px;border:1px solid #444">
        <p style="margin:0 0 16px;font-size:16px;color:#eee">請輸入學號</p>
        <input id="_sid" type="text" placeholder="s113..." style="width:100%;padding:10px;box-sizing:border-box;background:#000;color:#fff;border:1px solid #555;border-radius:6px;font-size:15px;outline:none">
        <button id="_sok" style="margin-top:16px;width:100%;padding:10px;background:#2ed573;border:none;border-radius:6px;color:#fff;font-size:15px;cursor:pointer;font-weight:bold">確定</button>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#_sid');
    const btn   = overlay.querySelector('#_sok');
    input.focus();
    const done = () => { document.body.removeChild(overlay); resolve(input.value.trim() || 'Unknown'); };
    btn.onclick = done;
    input.onkeydown = e => { if (e.key === 'Enter') done(); };
  });

  if (!studentId) studentId = "Unknown";
  await uploadPending();
  await fetchZones();
  setInterval(fetchZones, 30000);

  faceMesh = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: CONF, minTrackingConfidence: CONF });
  faceMesh.onResults(onFaceResults);
  const cam = new Camera(videoInput, { onFrame: async () => await faceMesh.send({ image: videoInput }), width: CAM_W, height: CAM_H });
  cam.start();

  showCenterMsg("請點擊螢幕開始校正");
  videoContainer.style.display = 'flex';
  window.addEventListener('pointerdown', function h() { window.removeEventListener('pointerdown', h); startCalibration(); });
}

const _camScript = document.createElement('script');
_camScript.src = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js";
_camScript.onload = init;
document.head.appendChild(_camScript);