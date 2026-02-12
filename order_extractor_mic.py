# order_extractor_mic.py
import os
import json
import time
from pathlib import Path
from dotenv import load_dotenv, find_dotenv
from openai import AzureOpenAI
import speech_recogition as mic
import text_to_voice as speaker
import cosmos as db

load_dotenv(find_dotenv(), override=True)

ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
DEPLOY = os.getenv("AZURE_OPENAI_DEPLOYMENT")


def die(msg):
    raise SystemExit("❌ " + msg)


# ---- sanity print once ----
print("ENDPOINT =", repr(ENDPOINT))
print("DEPLOY   =", repr(DEPLOY))
print("API VER  =", repr(VERSION))
print("KEY LEN  =", len(API_KEY) if API_KEY else None)

if (
    not ENDPOINT
    or not ENDPOINT.startswith("https://")
    or "openai.azure.com" not in ENDPOINT
):
    die("AZURE_OPENAI_ENDPOINT is wrong. Example: https://<yourname>.openai.azure.com/")
if not API_KEY:
    die("AZURE_OPENAI_API_KEY missing. Copy from Azure OpenAI → Keys and Endpoint.")
if not DEPLOY:
    die("AZURE_OPENAI_DEPLOYMENT missing. Use exact deployment name from portal.")

# ---- lazy AOAI client ----
_client = None


def get_client():
    global _client
    if _client is None:
        _client = AzureOpenAI(
            azure_endpoint=ENDPOINT,
            api_key=API_KEY,
            api_version=VERSION,
        )
    return _client


# ========== Session variables (set from client via WS "init") ==========
CUSTOMER_NAME = None  # e.g., "Bob"
ORDER_OPTION = None  # "dinein" | "takeaway"


def _build_system_prompt() -> str:
    name = CUSTOMER_NAME or "ลูกค้า"
    opt = ORDER_OPTION or "dinein"
    opt_th = "ทานที่ร้าน" if opt.lower().startswith("dine") else "ใส่ถุงกลับบ้าน"
    return f"""
You are "ฟ้าใส" an AI order taker for a Thai "ร้านอาหารตามสั่ง" called "อาตี๋ตามสั่ง".
Speak naturally in Thai and keep messages short and polite.

Known session info:
- customerName: {name}
- option: {opt} ({opt_th}) just remember, do not say this to the customer

Core behavior:
- Keep a running memory of all ordered items across turns.
- For each item: track fields: name, qty (default 1), and notes (e.g., "ไม่เผ็ด", "เพิ่มไข่ดาว" leave deafault if not specified).
- If customer already mentioned qty or notes, do not ask again.
- Confirm unclear details (e.g., quantity, options) as needed.

When the customer indicates they are finished (e.g., "พอแล้ว", "เท่านี้", "ใช่", "จบแล้ว", "เรียบร้อย", "แค้นี้แหละ"):
1) Say a concise Thai confirmation and read back the full order in a list.
2) Then on a NEW LINE output a single machine-parsable line starting with:
   ORDER_SUMMARY_JSON=ORDER_SUMMARY_JSON={{"finalized":true ,"order":{{"id":{time.strftime("%Y%m%d-%H%M%S")}, "status":"pending", "customerName":"{name}","items":[{{"name":"...","qty":...,"notes":"..."}}],"option":"{opt}"}}}}
   - The JSON must be valid and single-line.
   - The JSON must be parse even if there is a single item or many items.
   - example:
   {{"finalized":true, "order":{{"id":"20251004-163028", "status":"pending", "customerName":"{name}","items":[{{"name":"ผัดกะเพราไก่","qty":2,"notes":"เพิ่มไข่ดาว"}}],"option":"{opt}"}}}}

If the order is NOT finished yet, DO NOT output ORDER_SUMMARY_JSON.
if customer says "reset", "start over", "clear" or similar (in thai as well), clear the order memory and start fresh.
If the customer says something unrelated to ordering, politely steer them back to ordering.
""".strip()


WINDOW_TURNS = 2
history = [{"role": "system", "content": _build_system_prompt()}]


def set_customer_info(name: str, option: str):
    """Called by the server when the client submits the pre-chat form."""
    global CUSTOMER_NAME, ORDER_OPTION, history
    CUSTOMER_NAME = (name or "").strip() or None
    ORDER_OPTION = (option or "").strip().lower() or None
    # refresh the system message in-place
    if history and history[0]["role"] == "system":
        history[0]["content"] = _build_system_prompt()
    else:
        history.insert(0, {"role": "system", "content": _build_system_prompt()})


def build_windowed_messages(full_history, k: int):
    system_msg = full_history[0:1]
    ua = [m for m in full_history[1:] if m["role"] in ("user", "assistant")]
    if k <= 0:
        last_user = next((m for m in reversed(ua) if m["role"] == "user"), None)
        return system_msg + ([last_user] if last_user else [])
    if not ua:
        return system_msg
    last_user_idx = max(i for i, m in enumerate(ua) if m["role"] == "user")
    trimmed = ua[max(0, last_user_idx - (k * 2 - 1)) : last_user_idx + 1]
    return system_msg + trimmed


def ask(messages):
    resp = get_client().chat.completions.create(
        model=DEPLOY,
        messages=messages,
        temperature=0.7,
        max_completion_tokens=500,
    )
    return resp.choices[0].message.content.strip()


def _extract_summary_line(text: str):
    if not text:
        return text, None
    lines = text.splitlines()
    summary_obj = None
    keep_lines = []
    for ln in lines:
        if ln.startswith("ORDER_SUMMARY_JSON="):
            payload = ln[len("ORDER_SUMMARY_JSON=") :].strip()
            try:
                summary_obj = json.loads(payload)
            except Exception:
                summary_obj = None
        else:
            keep_lines.append(ln)
    clean = "\n".join(keep_lines).strip()
    return clean, summary_obj


def _store_summary(summary: dict) -> str:
    Path("orders").mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = Path("orders") / f"order-{ts}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        db.add_order(summary)  
    return str(path)


def process_user_text(user_text: str):
    """Returns str or dict(text, summary, saved_path)."""
    global history
    if not user_text:
        return ""
    history.append({"role": "user", "content": user_text})
    to_send = build_windowed_messages(history, WINDOW_TURNS)
    reply = ask(to_send)
    clean_text, summary = _extract_summary_line(reply)
    history.append({"role": "assistant", "content": clean_text})

    if summary and isinstance(summary, dict) and summary.get("finalized") is True:
        saved_path = _store_summary(summary)
        return {"text": clean_text, "summary": summary, "saved_path": saved_path}
    return clean_text


def reset_conversation():
    """Clear the history so each session starts fresh."""
    global history
    history = [{"role": "system", "content": _build_system_prompt()}]


# ---- standalone mic loop for local test ----
def main():
    print("🎙️ Voice chat (windowed). Say something. Say 'quit' to exit.\n")
    try:
        while True:
            user_text = mic.recognize_from_microphone()
            print(f"Recognized: {user_text}")
            if not user_text:
                continue
            if user_text.lower() in {"quit", "exit", "bye"}:
                print("👋 Bye")
                break

            result = process_user_text(user_text)
            if isinstance(result, dict):
                print(f"\n🧑 You: {user_text}")
                print(f"🤖 Assistant: {result['text']}\n")
                speaker.synthesize_to_speaker(result["text"])
                print("📦 Saved order to:", result["saved_path"])
                print("🧾 Summary:", json.dumps(result["summary"], ensure_ascii=False))
            else:
                print(f"\n🧑 You: {user_text}")
                print(f"🤖 Assistant: {result}\n")
                speaker.synthesize_to_speaker(result)
    except KeyboardInterrupt:
        print("\n🛑 Stopped")


if __name__ == "__main__":
    try:
        r = get_client().chat.completions.create(
            model=DEPLOY,
            messages=[{"role": "user", "content": "Say hello in Thai"}],
            max_completion_tokens=16,
        )
        print("✅ AOAI OK:", r.choices[0].message.content)
    except Exception as e:
        print("❌ AOAI call failed:", e)
    main()
