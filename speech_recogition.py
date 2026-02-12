#  speech_recogition.py
import os
import azure.cognitiveservices.speech as speechsdk
from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(), override=True)

def from_file():
    speech_config = speechsdk.SpeechConfig(
        subscription=os.environ.get("SPEECH_KEY"),
        endpoint=os.environ.get("SPEECH_ENDPOINT"),
    )
    speech_config.speech_recognition_language = "th-TH"
    audio_config = speechsdk.AudioConfig(filename="Recording.wav")
    speech_recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config, audio_config=audio_config
    )

    speech_recognition_result = speech_recognizer.recognize_once_async().get()
    print(speech_recognition_result.text)


# from_file()


def recognize_from_microphone():
    # This example requires environment variables named "SPEECH_KEY" and "ENDPOINT"
    # Replace with your own subscription key and endpoint, the endpoint is like : "https://YourServiceRegion.api.cognitive.microsoft.com"
    speech_config = speechsdk.SpeechConfig(
        subscription=os.environ.get("SPEECH_KEY"),
        endpoint=os.environ.get("SPEECH_ENDPOINT"),
    )
    speech_config.speech_recognition_language = "th-TH"

    audio_config = speechsdk.audio.AudioConfig(use_default_microphone=True)
    speech_recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config, audio_config=audio_config
    )

    print("Speak into your microphone.")
    speech_recognition_result = speech_recognizer.recognize_once_async().get()

    if speech_recognition_result.reason == speechsdk.ResultReason.RecognizedSpeech:
        # print("Recognized: {}".format(speech_recognition_result.text))
        return (speech_recognition_result.text)
    elif speech_recognition_result.reason == speechsdk.ResultReason.NoMatch:
        print(
            "No speech could be recognized: {}".format(
                speech_recognition_result.no_match_details
            )
        )
    elif speech_recognition_result.reason == speechsdk.ResultReason.Canceled:
        cancellation_details = speech_recognition_result.cancellation_details
        print("Speech Recognition canceled: {}".format(cancellation_details.reason))
        if cancellation_details.reason == speechsdk.CancellationReason.Error:
            print("Error details: {}".format(cancellation_details.error_details))
            print("Did you set the speech resource key and endpoint values?")


# sr = (recognize_from_microphone())
# print(sr)