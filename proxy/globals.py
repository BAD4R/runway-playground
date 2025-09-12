# -*- coding: utf-8 -*-
"""
Global objects container
"""

# Глобальные объекты - инициализируются в main.py
openai_limiter = None
elevenlabs_rate_limiter = None
proxy_manager = None
elevenlabs_manager = None
elevenlabs_queue = None
stats = None
app = None

def init_globals(**kwargs):
    """Инициализация глобальных объектов"""
    global openai_limiter, elevenlabs_rate_limiter
    global proxy_manager, elevenlabs_manager, elevenlabs_queue, stats, app

    openai_limiter = kwargs.get('openai_limiter')
    elevenlabs_rate_limiter = kwargs.get('elevenlabs_rate_limiter')
    proxy_manager = kwargs.get('proxy_manager')
    elevenlabs_manager = kwargs.get('elevenlabs_manager')
    elevenlabs_queue = kwargs.get('elevenlabs_queue')
    stats = kwargs.get('stats')
    app = kwargs.get('app')
