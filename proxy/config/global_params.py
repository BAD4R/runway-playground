# -*- coding: utf-8 -*-
"""Utilities for loading global parameters such as OpenAI limits."""
import json
import os

# Path to the global parameters file. Can be overridden via ENV variable.
GLOBAL_PARAMS_PATH = os.environ.get(
    "GLOBAL_PARAMS_PATH",
    "C:/Users/V/Desktop/Channels/globalParams.json",
)

def _load_file(path: str) -> dict:
    """Safely load JSON data from ``path``.

    Returns an empty dict if the file is missing or invalid.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def load_openai_limits(path: str = GLOBAL_PARAMS_PATH) -> dict:
    """Return OpenAI rate limits mapping from the global params file."""
    data = _load_file(path)
    return data.get("openAiLimits", {})


def load_elevenlabs_limits(path: str = GLOBAL_PARAMS_PATH) -> dict:
    """Return ElevenLabs limits from the global params file."""
    data = _load_file(path)
    return data.get("11LabsLimits", {})


def load_recraft_limits(path: str = GLOBAL_PARAMS_PATH) -> dict:
    """Return Recraft limits from the global params file."""
    data = _load_file(path)
    return data.get("recraftLimits", {})

__all__ = [
    "load_openai_limits",
    "load_elevenlabs_limits",
    "load_recraft_limits",
    "GLOBAL_PARAMS_PATH",
]
