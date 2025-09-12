# -*- coding: utf-8 -*-
"""
Main entry point for the proxy server
"""
import threading
import logging

from utils.logger import log
from utils.logging import ShortURLFilter
from core.rate_limiters import OpenAIRateLimiter, ElevenLabsRateLimiter
from core.stats import stats, _stats_loop, _rate_limit_monitor
from proxy.mobile_proxy import MobileProxyManager
from proxy.proxy_manager import ElevenLabsProxyManager
from services.elevenlabs_manager import ElevenLabsManager, ElevenLabsQueue
from web.routes import create_app
from web.excel_management import register_excel_routes


# ====================================================================
# GLOBAL SETUP
# ====================================================================

# Rate limiters
openai_limiter = OpenAIRateLimiter()
elevenlabs_rate_limiter = ElevenLabsRateLimiter()


# Managers
proxy_manager = ElevenLabsProxyManager()
elevenlabs_manager = ElevenLabsManager()
elevenlabs_queue = ElevenLabsQueue(excel_path=elevenlabs_manager.excel_path)

def start_background_threads():
    """Запускает фоновые потоки"""
    # Statistics thread
    threading.Thread(target=_stats_loop, daemon=True).start()

    # Rate limit monitor thread
    threading.Thread(target=_rate_limit_monitor, daemon=True).start()

def setup_mobile_proxy():
    """Настройка мобильного прокси (один экземпляр для всех менеджеров)"""
    MOBILE_PROXY_ID = "407714"
    MOBILE_API_KEY = "f2d5358b7c6d4159663d9899605f245e"

    if not (MOBILE_PROXY_ID and MOBILE_API_KEY):
        log.warning("⚠️ MOBILE_PROXY_ID/MOBILE_API_KEY not configured")
        return

    # 1) Создаём ОДИН MobileProxyManager через ProxyManager
    pm_success = proxy_manager.set_mobile_proxy(MOBILE_PROXY_ID, MOBILE_API_KEY)
    if not pm_success:
        log.error("❌ ProxyManager mobile proxy config failed")
        return

    # 2) Переиспользуем тот же экземпляр в ElevenLabsManager (без повторных API-запросов)
    elevenlabs_manager.mobile_proxy = proxy_manager.mobile_proxy
    # Передаём тот же прокси очереди ElevenLabs
    elevenlabs_queue.mobile_proxy = proxy_manager.mobile_proxy
    current_ip = proxy_manager.mobile_proxy.current_ip or "configured"

    print(f"✅ Mobile proxy configured automatically: {current_ip}")
    log.info(f"✅ Mobile proxy configured automatically: {current_ip}")
    log.info("🔁 Reused single MobileProxyManager for all managers")

def setup_logging_filters():
    """Настройка фильтров логирования"""
    werkzeug_logger = logging.getLogger('werkzeug')
    werkzeug_logger.addFilter(ShortURLFilter())
    werkzeug_logger.setLevel(logging.WARNING)
    # ДОБАВЛЯЕМ DEBUG логирование для ElevenLabs
    elevenlabs_logger = logging.getLogger("proxy")
    elevenlabs_logger.setLevel(logging.DEBUG)  # Включаем DEBUG логи

def main():
    """Главная функция запуска сервера"""
    print("🚀 Enhanced Proxy Server starting on 0.0.0.0:8001")
    log.info("🚀 Enhanced Proxy Server starting on 0.0.0.0:8001")
    
    # Запуск фоновых потоков
    start_background_threads()
    
    # Настройка мобильного прокси
    setup_mobile_proxy()
    
    # Настройка логирования
    setup_logging_filters()
    
    # Создание Flask приложения
    app = create_app()
    register_excel_routes(app)
    
    # Инициализация глобальных объектов
    import globals as g
    g.init_globals(
        openai_limiter=openai_limiter,
        elevenlabs_rate_limiter=elevenlabs_rate_limiter,
        proxy_manager=proxy_manager,
        elevenlabs_manager=elevenlabs_manager,
        elevenlabs_queue=elevenlabs_queue,
        stats=stats,
        app=app,
    )
    
    # Запуск сервера
    app.run(host="0.0.0.0", port=8001, threaded=True)
__all__ = ['openai_limiter', 'elevenlabs_rate_limiter',
           'proxy_manager', 'elevenlabs_manager', 'elevenlabs_queue']

if __name__ == "__main__":
    main()
