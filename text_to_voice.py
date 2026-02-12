import os
import base64
from xml.sax.saxutils import escape
from functools import lru_cache
import azure.cognitiveservices.speech as speechsdk

VOICE_NAME = "th-TH-PremwadeeNeural"
PROSODY_RATE = "-10%"
OUTPUT_FORMAT ="Audio24Khz48KBitRateMonoMp3"


@lru_cache(maxsize=1)
def _output_mime() -> str:
    return "audio/mpeg" if "Mp3" in OUTPUT_FORMAT else "audio/wav"

@lru_cache(maxsize=1)
def _credential_tuple():
    subscription = os.environ.get("SPEECH_KEY")
    endpoint = os.environ.get("SPEECH_ENDPOINT")
    region = os.environ.get("SPEECH_REGION")
    if not subscription:
        raise RuntimeError("SPEECH_KEY environment variable is missing")
    return subscription, region, endpoint

@lru_cache(maxsize=1)
def _output_format():
    try:
        return getattr(speechsdk.SpeechSynthesisOutputFormat, OUTPUT_FORMAT)
    except AttributeError as exc:
        raise RuntimeError(
            f"Unsupported speech output format '{OUTPUT_FORMAT}'."
        ) from exc

def _build_speech_config() -> speechsdk.SpeechConfig:
    subscription, region, endpoint = _credential_tuple()
    if region:
        speech_config = speechsdk.SpeechConfig(subscription=subscription, region=region)
    elif endpoint:
        speech_config = speechsdk.SpeechConfig(subscription=subscription, endpoint=endpoint)
    else:
        raise RuntimeError("Set SPEECH_REGION or SPEECH_ENDPOINT for speech synthesis")
    speech_config.speech_synthesis_voice_name = VOICE_NAME
    speech_config.set_speech_synthesis_output_format(_output_format())
    return speech_config

def _build_ssml(text: str) -> str:
    safe_text = escape(text)
    return (
        "<speak version='1.0' xml:lang='en-US'>"
        f"<voice name='{VOICE_NAME}'>"
        f"<prosody rate='{PROSODY_RATE}'>"
        f"{safe_text}"
        "</prosody>"
        "</voice>"
        "</speak>"
    )

def synthesize_avatar_audio(text: str) -> tuple[bytes, str]:
    """Synthesize text to Azure voice audio bytes and return (audio_bytes, mime_type)."""
    if not text:
        return b"", _output_mime()
    speech_config = _build_speech_config()
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
    result = synthesizer.speak_ssml_async(_build_ssml(text)).get()
    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        audio_bytes = result.audio_data or b""
        return audio_bytes, _output_mime()
    if result.reason == speechsdk.ResultReason.Canceled:
        details = result.cancellation_details
        raise RuntimeError(f"Speech synthesis canceled: {details.reason}: {details.error_details}")
    raise RuntimeError(f"Speech synthesis failed with reason: {result.reason}")

def synthesize_avatar_base64(text: str) -> tuple[str, str]:
    audio_bytes, mime = synthesize_avatar_audio(text)
    encoded = base64.b64encode(audio_bytes).decode("ascii") if audio_bytes else ""
    return encoded, mime

__all__ = ["synthesize_avatar_audio", "synthesize_avatar_base64"]


