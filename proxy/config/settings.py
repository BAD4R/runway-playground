# -*- coding: utf-8 -*-
"""
Configuration settings for the proxy server
"""

# Default configurations
DEFAULT_OPENAI_CONFIG = {}


# Default configuration for proxy manager / audio requests
# Kept for compatibility but intentionally left empty
DEFAULT_AUDIO_CONFIG = {}

def get_config_from_request(request_args, defaults):
    """Читает конфигурацию из параметров запроса"""
    config = {}
    for key, default_value in defaults.items():
        value = request_args.get(key)
        if value is not None:
            try:
                if isinstance(default_value, int):
                    config[key] = int(value)
                elif isinstance(default_value, float):
                    config[key] = float(value)
                else:
                    config[key] = value
            except (ValueError, TypeError):
                config[key] = default_value
        else:
            config[key] = default_value
    return config

def get_openai_config(request_args=None):
    """Получает конфигурацию OpenAI из запроса или дефолтную"""
    if request_args:
        return get_config_from_request(request_args, DEFAULT_OPENAI_CONFIG)
    return DEFAULT_OPENAI_CONFIG.copy()

