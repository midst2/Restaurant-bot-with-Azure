# server.py
import os
import asyncio
import json
from dotenv import load_dotenv, find_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import logging

import azure.cognitiveservices.speech as speechsdk

# ---- your app logic ----
from order_extractor_mic import process_user_text, set_customer_info, reset_conversation

from text_to_voice import synthesize_avatar_base64, synthesize_avatar_audio  # TTS helpers

logging.basicConfig(level=logging.INFO)
load_dotenv(find_dotenv(), override=True)

# ---- FastAPI setup ----
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

HTML = """<!doctype html><meta http-equiv="refresh" content="0; url=/static/index.html">"""
@app.get("/")
def root():
    return HTMLResponse(HTML)

# ---- Azure Speech config factory (STT) ----
def make_speech_recognizer():
    speech_config = speechsdk.SpeechConfig(
        subscription=os.getenv("SPEECH_KEY"),
        region=os.getenv("SPEECH_REGION")
    )
    # Thai
    speech_config.speech_recognition_language = "th-TH"

    # Raw PCM 16kHz mono 16-bit
    stream_format = speechsdk.audio.AudioStreamFormat(
        samples_per_second=16000, bits_per_sample=16, channels=1
    )
    push_stream = speechsdk.audio.PushAudioInputStream(stream_format)
    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
    recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config, audio_config=audio_config
    )
    return recognizer, push_stream

# ---- Run blocking TTS in executor ----
async def tts_base64_async(text: str) -> tuple[str, str]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, synthesize_avatar_base64, text)

async def tts_audio_async(text: str) -> tuple[bytes, str]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, synthesize_avatar_audio, text)

# ---- WebSocket endpoint: STT + bot reply + TTS (base64) ----
@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    await ws.accept()
    recognizer, push_stream = make_speech_recognizer()

    loop = asyncio.get_event_loop()

    async def ws_send(payload: dict):
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass

    # ---------- Azure SDK event handlers ----------
    def _on_recognizing(evt: speechsdk.SessionEventArgs):
        result = evt.result
        if result and result.text:
            asyncio.run_coroutine_threadsafe(
                ws_send({"type": "partial", "text": result.text}), loop
            )

    last_final_text = None

    def _on_recognized(evt):
        nonlocal last_final_text
        result = evt.result
        if not result or not result.text:
            return

        text = result.text.strip()
        if not text:
            return

        # Dedupe finals
        if text == last_final_text:
            return
        last_final_text = text

        # Send user's final transcript
        asyncio.run_coroutine_threadsafe(
            ws_send({"type": "final", "text": text}), loop
        )

        # Handle bot reply (call your AOAI code + TTS)
        async def handle_bot():
            try:
                reply = process_user_text(text)  # may return str OR dict

                # Normalize shape
                if isinstance(reply, dict):
                    reply_text = reply.get("text", "")
                    order_summary = reply.get("summary")  # dict if finalized
                    saved_path = reply.get("saved_path")
                else:
                    reply_text = str(reply)
                    order_summary = None
                    saved_path = None

                # TTS for reply
                b64, mime = "", ""
                if reply_text:
                    try:
                        b64, mime = await tts_base64_async(reply_text)
                        print(f"[TTS] generated {len(b64)} base64 chars, mime={mime}")
                    except Exception as tts_ex:
                        await ws_send({"type": "error", "reason": f"TTS failed: {tts_ex}"})

                payload = {
                    "type": "bot",
                    "text": reply_text,
                    "audio": b64,   # base64 audio for client
                    "mime": mime    # e.g. "audio/mpeg" or "audio/wav"
                }

                # If model finalized, include JSON and saved path
                if order_summary:
                    payload["order"] = order_summary
                    if saved_path:
                        payload["saved_path"] = saved_path

                await ws_send(payload)

            except Exception as ex:
                await ws_send({"type": "error", "reason": f"bot failed: {ex}"})

        asyncio.run_coroutine_threadsafe(handle_bot(), loop)

    def _on_canceled(evt: speechsdk.SessionEventArgs):
        asyncio.run_coroutine_threadsafe(
            ws_send({"type": "error", "reason": str(evt.result.cancellation_details)}),
            loop,
        )

    def _on_session_stopped(evt):
        asyncio.run_coroutine_threadsafe(ws_send({"type": "done"}), loop)

    recognizer.recognizing.connect(_on_recognizing)
    recognizer.recognized.connect(_on_recognized)
    recognizer.canceled.connect(_on_canceled)
    recognizer.session_stopped.connect(_on_session_stopped)

    # Start continuous recognition
    await asyncio.get_event_loop().run_in_executor(
        None, lambda: recognizer.start_continuous_recognition_async().get()
    )

    # ---------- Receive loop ----------
    try:
        while True:
            msg = await ws.receive()
            if "type" in msg and msg["type"] == "websocket.disconnect":
                break

            # Binary: PCM frames from client mic
            if "bytes" in msg and msg["bytes"] is not None:
                data: bytes = msg["bytes"]
                push_stream.write(data)

            # Text: control channel (init / close)
            elif "text" in msg and msg["text"] is not None:
                txt = msg["text"]

                # Explicit close from client
                if txt == "__close_stream__":
                    push_stream.close()
                    await asyncio.get_event_loop().run_in_executor(
                        None, lambda: recognizer.stop_continuous_recognition_async().get()
                    )
                    await ws_send({"type": "done"})
                    break
                
                # reset conversation
                if txt == "__reset__":
                    reset_conversation()
                    await ws_send({"type": "system", "text": "Conversation has been reset."})
                    continue    
                    
                # Try to decode JSON control messages (e.g., init)
                try:
                    payload = json.loads(txt)
                except Exception:
                    payload = None

                if isinstance(payload, dict) and payload.get("type") == "init":
                    # Pre-chat metadata from modal
                    name = payload.get("customerName", "")
                    option = payload.get("option", "")
                    try:
                        set_customer_info(name, option)
                        await ws_send({"type": "system", "text": f"Session ready for {name or 'ลูกค้า'} ({option or 'dinein'})."})
                    except Exception as ex:
                        await ws_send({"type": "error", "reason": f"init failed: {ex}"})
                    continue

    except WebSocketDisconnect:
        pass
    except Exception as ex:
        await ws_send({"type": "error", "reason": str(ex)})
    finally:
        try:
            push_stream.close()
        except Exception:
            pass

if __name__ == "__main__":
    # 0.0.0.0 for LAN testing if you need; 'localhost' is fine
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
