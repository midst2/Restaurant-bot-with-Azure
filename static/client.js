/* client.js — robust mobile audio + lip-sync + prechat + final summary (auto-resume mic, subtitle shows bot text) */
import { loadAvatar } from "./avatar.js";

const micButton = document.getElementById("micButton");
const historyButton = document.getElementById("historyButton");
const chatModal = document.getElementById("chatModal");
const closeModalButton = document.getElementById("closeModal");
const statusEl = document.getElementById("status");
const subtitleEl = document.getElementById("subtitle");
const chatStream = document.getElementById("chatStream");
const avatarStage = document.getElementById("avatarStage");

// Modals
const prechatModal = document.getElementById("prechatModal");
const startSessionBtn = document.getElementById("startSessionBtn");
const customerNameInput = document.getElementById("customerNameInput");
const finalModal = document.getElementById("finalModal");
const finalContent = document.getElementById("finalContent");
const closeFinalBtn = document.getElementById("closeFinalBtn");

// Optional mouth path inside your SVG avatar
let mouthEl = null;

// Mic icon span (optional)
const micIcon = document.getElementById("micIcon");

const WS_URL =
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/transcribe";

// =================== State ===================
let ws;
let audioCtx; // capture context
let mediaStream;
let workletNode;
let isListening = false;
let latestUserBubble;

// Session (from prechat)
let sessionReady = false;
let sessionCustomerName = "";
let sessionOption = "dinein";

// === MIC LOCK + AUTO-RESUME ===
let botSpeaking = false; // true while TTS is playing / queued
let capturePaused = false; // true => we drop frames instead of sending to WS
let pendingStart = false; // user tried to start while locked
let wasListeningBeforeSpeak = false; // remember live state

function setMicLock(locked, hint = "รอสักครู่ ให้ผู้ช่วยพูดจบก่อน") {
  if (!micButton) return;
  if (locked) {
    // Do NOT stop listening; just pause uplink
    if (isListening) {
      wasListeningBeforeSpeak = true;
      capturePaused = true; // pause uplink to server
      setStatus("Assistant speaking…");
      // NOTE: do not overwrite subtitle (it should show the bot's text)
      micButton.classList.add("locked");
      micButton.disabled = true;
      micButton.setAttribute("title", hint);
      if (micIcon) {
        micIcon.className = "fa-solid fa-spinner";
        micIcon.classList.add("spin");
      }
      avatarStage?.classList.add("mic-locked");
    } else {
      wasListeningBeforeSpeak = false;
      micButton.classList.add("locked");
      micButton.disabled = true;
      micButton.setAttribute("title", hint);
      if (micIcon) {
        micIcon.className = "fa-solid fa-spinner";

      }
      avatarStage?.classList.add("mic-locked");
    }
  } else {
    micButton.disabled = false;
    micButton.classList.remove("locked");
    micButton.removeAttribute("title");
    avatarStage?.classList.remove("mic-locked");
    micIcon.classList.remove("spin");

    // If we were listening before, auto-unpause
    if (wasListeningBeforeSpeak && isListening) {
      capturePaused = false; // resume uplink
      setStatus("Listening live");
      // keep subtitle as-is (bot text remains until next partial/final)
      if (micIcon) micIcon.className = "fa-solid fa-xmark";
    } else if (pendingStart && !isListening) {
      // User tried to start while locked -> start now
      pendingStart = false;
      startListening();
    } else {
      // Idle state
      if (micIcon) { micIcon.className = "fa-solid fa-microphone"; }
      setStatus(isListening ? "Listening live" : "Idle");
    }
    wasListeningBeforeSpeak = false;
  }
}

// =================== UI helpers ===================
function setStatus(text) {
  statusEl.textContent = text;
}
function updateSubtitle(text, dim = false) {
  subtitleEl.textContent = text || "";
  subtitleEl.classList.toggle("muted", Boolean(text && dim));
}
function addBubble(text, role = "system", extra = {}) {
  if (!text) return null;
  const el = document.createElement("div");
  el.className = `bubble ${role}${extra.partial ? " partial" : ""}${extra.final ? " final" : ""}`;
  el.textContent = text;
  chatStream.appendChild(el);
  chatStream.scrollTop = chatStream.scrollHeight;
  return el;
}
function openModal(el) {
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
}
function closeModal(el) {
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
}

// Show prechat at load
openModal(prechatModal);

// =================== Robust audio player (single AudioContext, queue, lip-sync) ===================
let playbackCtx = null;
let gainNode = null;
let analyser = null;
let playing = false;
let playQueue = [];
let firstSoundEnabled = false;
let rafId = null;

function ensurePlaybackCtx() {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = playbackCtx.createGain();
    analyser = playbackCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    analyser.connect(gainNode);
    gainNode.connect(playbackCtx.destination);
  }
  return playbackCtx;
}
async function resumePlaybackCtx() {
  const ctx = ensurePlaybackCtx();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch { }
  }
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function mouthRestPath() {
  return "M74,136 Q100,144 126,136 Q100,156 74,136 Z";
}
function mouthPathAmount(amount) {
  const baseY = 136,
    topY = baseY,
    openY = baseY + 8 + amount * 22,
    mid = 100,
    leftX = 74,
    rightX = 126;
  return `M${leftX},${topY} Q${mid},${topY + 8} ${rightX},${topY} Q${mid},${openY} ${leftX},${topY} Z`;
}
function startLipSyncFromNode(sourceNode) {
  try {
    sourceNode.connect(analyser);
  } catch { }
  avatarStage.classList.add("speaking");

  // Lock as soon as audio starts
  botSpeaking = true;
  setMicLock(true);

  if (!mouthEl) return;
  const loop = () => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const open = Math.min(1, Math.max(0, (rms - 0.02) * 10));
    mouthEl.setAttribute("d", mouthPathAmount(open));
    rafId = requestAnimationFrame(loop);
  };
  if (!rafId) loop();
}
function stopLipSync() {
  avatarStage.classList.remove("speaking");
  if (rafId) (cancelAnimationFrame(rafId), (rafId = null));
  if (mouthEl) mouthEl.setAttribute("d", mouthRestPath());
}

// Show “Enable Sound” button proactively; it disappears after first play
function showEnableSoundButton() {
  if (firstSoundEnabled) return;
  let btn = document.getElementById("enableSoundBtn");
  if (btn) return;
  btn = document.createElement("button");
  btn.id = "enableSoundBtn";
  btn.textContent = "Enable Sound";
  btn.className = "ghost-btn";
  btn.style.position = "fixed";
  btn.style.right = "16px";
  btn.style.bottom = "16px";
  btn.style.zIndex = 1000;
  btn.addEventListener("click", async () => {
    await resumePlaybackCtx();
    firstSoundEnabled = true;
    btn.remove();
  });
  document.body.appendChild(btn);
}

async function enqueueAudioBase64(audioB64) {
  const bytes = b64ToBytes(audioB64);
  playQueue.push(bytes);
  if (!playing) playNextInQueue();
}

async function playNextInQueue() {
  if (playing) return;
  const bytes = playQueue.shift();
  if (!bytes) {
    // Unlock when the queue drains
    botSpeaking = false;
    setMicLock(false);
    return;
  }

  playing = true;
  try {
    await resumePlaybackCtx();
    const ctx = ensurePlaybackCtx();
    const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;

    startLipSyncFromNode(src);

    src.onended = () => {
      try {
        src.disconnect();
      } catch { }
      stopLipSync();
      playing = false;
      if (playQueue.length > 0) {
        playNextInQueue();
      } else {
        botSpeaking = false;
        setMicLock(false);
      }
    };

    // connect: src -> analyser (analyser -> gain -> destination already set)
    src.connect(analyser);
    src.start(0);

    firstSoundEnabled = true;
    const btn = document.getElementById("enableSoundBtn");
    if (btn) btn.remove();
  } catch (err) {
    console.warn("Audio decode/play failed", err);
    showEnableSoundButton();
    playing = false;
    // Avoid deadlock on error
    botSpeaking = false;
    setMicLock(false);
  }
}

function playBotAudio(audioB64, _mime = "audio/mpeg") {
  // Lock immediately when any audio arrives
  botSpeaking = true;
  setMicLock(true);
  enqueueAudioBase64(audioB64);
}

function stopAudioPlayback() {
  playQueue = [];
  stopLipSync();
  // Do NOT unlock here; unlock flows from queue drain/stop
}

// =================== WebSocket ===================
async function ensureWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus("Connected");
    // send session init once per connection if ready
    if (sessionReady) {
      const init = { type: "init", customerName: sessionCustomerName, option: sessionOption };
      try {
        ws.send(JSON.stringify(init));
      } catch { }
    }
  };

  ws.onclose = () => setStatus("Disconnected");
  ws.onerror = () => setStatus("WS Error");

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === "system" && msg.text) {
      addBubble(msg.text, "system");
      return;
    }

    if (msg.type === "partial") {
      updateSubtitle(msg.text || "", true);
    } else if (msg.type === "final") {
      updateSubtitle(msg.text || "", false);
      latestUserBubble = addBubble(msg.text, "user", { final: true });
    } else if (msg.type === "bot") {
      // Always show bot text in subtitle
      updateSubtitle(msg.text || "", false);
      const bubble = addBubble(msg.text, "bot");

      if (msg.audio) {
        const mime = msg.mime || msg.audioMime || "audio/mpeg";
        playBotAudio(msg.audio, mime);
        // ensure subtitle remains the bot text after locking
        if (msg.text) updateSubtitle(msg.text, false);
      } else {
        // text-only bot message: unlock if we had been locked
        botSpeaking = false;
        setMicLock(false);
      }

      // Finalization: server includes { order, saved_path }
      if (msg.order && (msg.order.finalized || msg.order.order || msg.order.details || msg.order.items)) {
        // Show summary; mic state unchanged
        showFinalSummary(msg.order, msg.saved_path);
      }

      if (bubble && latestUserBubble) {
        latestUserBubble.classList.remove("partial");
        latestUserBubble = null;
      }
    } else if (msg.type === "error") {
      addBubble(msg.reason || "Unknown error", "system");
      setStatus("Error");
    } else if (msg.type === "done") {
      setStatus("Session closed");
      // optional: stopListening(true);
    }
  };

  // Wait until open
  await new Promise((res, rej) => {
    const id = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        clearInterval(id);
        res();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(id);
      rej(new Error("WS timeout"));
    }, 4000);
  });
}

// =================== Mic capture (Worklet + fallback) ===================
async function startListening() {
  if (!sessionReady) {
    openModal(prechatModal);
    return;
  }

  // If bot is speaking, defer start
  if (botSpeaking) {
    pendingStart = true;
    setMicLock(true); // do not overwrite subtitle
    return;
  }

  if (isListening) return;
  isListening = true;

  micButton.classList.add("active");
  micButton.setAttribute("aria-pressed", "true");
  if (micIcon) micIcon.className = "fa-solid fa-xmark";
  avatarStage.classList.add("listening");
  setStatus("Requesting microphone");

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioCtx.state === "suspended") await audioCtx.resume();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
      video: false
    });

    const src = audioCtx.createMediaStreamSource(mediaStream);

    // Try AudioWorklet
    let usedWorklet = false;
    try {
      await audioCtx.audioWorklet.addModule("./pcm-worklet.js");
      workletNode = new AudioWorkletNode(audioCtx, "pcm16-worklet", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { targetSampleRate: 16000 }
      });
      usedWorklet = true;
    } catch (e) {
      console.warn("AudioWorklet unavailable; falling back:", e);
    }

    await ensureWS();
    setStatus("Listening live");

    if (usedWorklet) {
      src.connect(workletNode);
      workletNode.port.onmessage = (event) => {
        // Drop frames while paused
        if (!ws || ws.readyState !== WebSocket.OPEN || capturePaused) return;
        ws.send(event.data);
      };
    } else {
      // Fallback: ScriptProcessor
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      src.connect(processor);
      processor.connect(audioCtx.destination);
      workletNode = processor;

      processor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || capturePaused) return; // drop while paused
        const input = e.inputBuffer.getChannelData(0);

        // Resample to 16 kHz if needed
        const resampled = (function resampleFloat32(inBuf, inRate, outRate) {
          if (inRate === outRate) return inBuf;
          const ratio = inRate / outRate;
          const newLen = Math.round(inBuf.length / ratio);
          const out = new Float32Array(newLen);
          for (let i = 0; i < newLen; i++) {
            const idx = i * ratio;
            const i0 = Math.floor(idx);
            const i1 = Math.min(i0 + 1, inBuf.length - 1);
            const frac = idx - i0;
            out[i] = inBuf[i0] * (1 - frac) + inBuf[i1] * frac;
          }
          return out;
        })(input, audioCtx.sampleRate, 16000);

        const buf = new ArrayBuffer(resampled.length * 2);
        const view = new DataView(buf);
        for (let i = 0, off = 0; i < resampled.length; i++, off += 2) {
          let s = Math.max(-1, Math.min(1, resampled[i]));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        ws.send(buf);
      };
    }
  } catch (error) {
    console.error(error);
    setStatus(`Failed: ${error.message}`);
    stopListening(true);
  }
}

function stopListening(skipSignal = false) {
  if (!isListening) return;
  isListening = false;

  micButton.classList.remove("active");
  micButton.setAttribute("aria-pressed", "false");
  if (micIcon) micIcon.className = botSpeaking ? "fa-folid fa-spinner" : "fa-solid fa-microphone";
  setStatus("Idle");
  avatarStage.classList.remove("listening");
  // do not touch subtitle; keep whatever was displayed
  // do NOT stop playback (bot can keep talking)

  try {
    if (workletNode) {
      if (workletNode.port) workletNode.port.onmessage = null;
      workletNode.disconnect?.();
      workletNode.onaudioprocess = null;
      workletNode = undefined;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = undefined;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = undefined;
    }
    if (ws) {
      if (!skipSignal && ws.readyState === WebSocket.OPEN) ws.send("__close_stream__");
      ws.close();
      ws = undefined;
    }
  } catch (err) {
    console.error("cleanup error", err);
  }

  // If bot is speaking, UI stays locked but we won't auto-resume since user explicitly stopped.
  if (botSpeaking) setMicLock(true);
}

//  show final summary (order, savedPath)
function showFinalSummary(orderObj, savedPath) {
  finalContent.innerHTML = "";

  // Fallbacks
  const name = orderObj.order?.customerName || sessionCustomerName || "Guest";
  const opt = orderObj.order?.option || sessionOption || "dinein";
  const ts = new Date();
  const orderId =
    orderObj.id ||
    `ORD-${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(
      ts.getDate()
    ).padStart(2, "0")}-${String(ts.getHours()).padStart(2, "0")}${String(
      ts.getMinutes()
    ).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`;

  // Items array from JSON
  const items = Array.isArray(orderObj.order?.items) ? orderObj.order.items : [];

  // === Build receipt ===
  const wrap = document.createElement("div");
  wrap.className = "receipt";

  // Hero header
  const hero = document.createElement("div");
  hero.className = "receipt__hero";
  hero.innerHTML = `
    <div class="receipt__hero-icon">🧾</div>
    <div>
      <h3>ใบสรุปออเดอร์ (Order Receipt)</h3>
      <small>${orderId}</small>
    </div>`;
  wrap.appendChild(hero);

  // Meta
  const meta = document.createElement("div");
  meta.className = "receipt__section receipt__meta";
  meta.innerHTML = `
    <div><b>ชื่อลูกค้า:</b> ${name}</div>
    <div><b>รูปแบบ:</b> ${opt === "takeaway" ? "ห่อกลับบ้าน" : "ทานที่ร้าน"}</div>
    <div><b>เวลา:</b> ${ts.toLocaleString()}</div>`;
    // ${savedPath ? `<div><b>ไฟล์ที่บันทึก:</b> ${savedPath}</div>` : ""}`;
  wrap.appendChild(meta);

  // Items
  const itemsSec = document.createElement("div");
  itemsSec.className = "receipt__section";
  itemsSec.innerHTML = `<div class="receipt__title">รายการอาหาร/เครื่องดื่ม</div>`;

  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "receipt__row";
    row.innerHTML = `
      <div>
        <div class="receipt__item-name">🍽️ ${it.name}</div>
        ${it.notes ? `<div class="receipt__item-note">หมายเหตุ: ${it.notes}</div>` : ""}
      </div>
      <div class="receipt__qty">x${it.qty || 1}</div>`;
    itemsSec.appendChild(row);
  });

  wrap.appendChild(itemsSec);

  // Thanks / Discord
  const thanks = document.createElement("div");
  thanks.className = "receipt__section receipt__thanks";
  thanks.innerHTML =
    `ขอบคุณที่สั่งอาหารกับเรา 🙏<br>เข้าร่วม Discord เพื่อรับการแจ้งเตือนใบเสร็จเมื่อออเดอร์เสร็จ`;
  wrap.appendChild(thanks);

  const actions = document.createElement("div");
  actions.className = "receipt__section receipt__actions";
  actions.innerHTML = `
    <a class="receipt__btn" id="joinDiscordBtn" href="https://discord.gg/pPkkyhDnbc" target="_blank" rel="noopener">เข้าร่วม Discord</a>`;
  wrap.appendChild(actions);

  finalContent.appendChild(wrap);

  openModal(finalModal);
}

// =================== Buttons & events ===================
startSessionBtn.addEventListener("click", () => {
  const name = (customerNameInput.value || "").trim();
  console.log("name");
  
  // read from active button
  const activeOptBtn = document.querySelector(".order-option-btn.active");
  const option = activeOptBtn ? activeOptBtn.dataset.value : "dinein";

  sessionCustomerName = name || "Guest";
  sessionOption = option;
  sessionReady = true;

  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "init",
          customerName: sessionCustomerName,
          option: sessionOption
        })
      );
    }
  } catch { }

  closeModal(prechatModal);
  setStatus(`Ready for ${sessionCustomerName} (${sessionOption})`);
});

micButton.addEventListener("click", () => {
  if (botSpeaking) {
    // remember the intent to start once unlock
    pendingStart = true;
    setMicLock(true); // tooltip + disabled only; keep current subtitle (bot text) visible
    return;
  }
  if (isListening) stopListening();
  else startListening();
});

historyButton.addEventListener("click", () => openModal(chatModal));
closeModalButton.addEventListener("click", () => closeModal(chatModal));
chatModal.addEventListener("click", (evt) => {
  if (evt.target === chatModal) closeModal(chatModal);
});

closeFinalBtn.addEventListener("click", () => window.location.reload());
finalModal.addEventListener("click", (evt) => {
  if (evt.target === finalModal) closeModal(finalModal);
});

window.addEventListener("beforeunload", () => {
  // close gracefully but do not fight playback
  if (isListening) stopListening(true);
});

// Toggle active state when buttons clicked
document.querySelectorAll(".order-option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".order-option-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// =================== Reset conversation on page load ===================
window.addEventListener("load", () => {
  try {
    const wsReset = new WebSocket(WS_URL);
    wsReset.onopen = () => {
      wsReset.send("__reset__");
      setTimeout(() => wsReset.close(), 150);
    };
  } catch (e) {
    console.warn("reset failed:", e);
  }
});

// Initial system bubble
addBubble(
  "กรอกชื่อและเลือกรูปแบบก่อนเริ่ม แล้วกด Start จากนั้นกด 🎙️ เพื่อพูดได้เลยค่ะ",
  "system"
);

// load default avatar file (you can switch path later)
loadAvatar("#avatarMount", "./avatar-simple.svg")
  .then(({ mouth }) => {
    mouthEl = mouth; // <-- lipsync uses this
  })
  .catch((err) => {
    console.error("Avatar load failed:", err);
  });

// Theme toggle (optional)
const themeToggle = document.getElementById("themeToggle");
const themeToggleIcon = document.getElementById("themeToggleIcon");
if (themeToggle) {
  const apply = (mode) => {
    document.body.classList.toggle("light", mode === "light");
    themeToggleIcon.className = mode === "light" ? "fa-solid fa-moon" : "fa-solid fa-sun";
    localStorage.setItem("theme", mode);
  };
  const saved = localStorage.getItem("theme") || "light"; // default to light
  apply(saved);

  themeToggle.addEventListener("click", () => {
    const next = document.body.classList.contains("light") ? "dark" : "light";
    apply(next);
  });
} else {
  // If you just want light without a button:
  document.body.classList.add("light");
}
