# -*- coding: utf-8 -*-
"""Proxy management using only rotating mobile proxies."""

import threading
from typing import Optional, Dict
from flask import request

from config.settings import DEFAULT_AUDIO_CONFIG
from utils.logger import log


class ProxyManager:
    """Manages access through a single rotating mobile proxy."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.current_proxy: Optional[Dict] = None
        self.config = DEFAULT_AUDIO_CONFIG.copy()
        self.mobile_proxy = None
        self.mobile_proxy_request_count = 0

    def get_requests_session(self, service: str = "openai", force_refresh: bool = False):
        """
        Возвращает requests.Session, сконфигурированный на мобильный HTTP-прокси.
        - Всегда выключаем наследование переменных окружения (trust_env=False)
        - Ставим ретраи и backoff на сетевые/статусные ошибки
        - При необходимости форсим обновление connection info
        """
        import requests
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        if not getattr(self, "mobile_proxy", None):
            raise RuntimeError("Mobile proxy is not configured")

        # Достаём connection info (host/port/login/pass) из кэша или обновляем
        conn = None
        if not force_refresh:
            conn = getattr(self.mobile_proxy, "connection_info_cache", None)

        if force_refresh or not conn:
            conn = self.mobile_proxy.get_connection_info()
        if not conn:
            raise RuntimeError("Cannot obtain proxy connection info")

        host = conn.get("host")
        port = conn.get("port")
        username = conn.get("username")
        password = conn.get("password")

        if not (host and port and username and password):
            raise RuntimeError(f"Bad proxy connection info: {conn}")

        # Формируем URL прокси (HTTP-прокси подходит и для https-ссылок через CONNECT)
        proxy_url = f"http://{username}:{password}@{host}:{port}"

        sess = requests.Session()
        sess.trust_env = False  # игнорируем системные переменные HTTP(S)_PROXY
        sess.proxies = {"http": proxy_url, "https": proxy_url}
        sess.headers.update({"Connection": "keep-alive"})

        # Ретраи и backoff: важное — allowed_methods=None, чтобы POST тоже ретраился
        retry = Retry(
            total=2,
            connect=2,
            read=2,
            status=2,
            backoff_factor=0.7,
            status_forcelist=[429, 502, 503, 504, 520, 521, 522, 523, 524],
            allowed_methods=None,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=50)
        sess.mount("http://", adapter)
        sess.mount("https://", adapter)

        # Лог — показываем только хост, порт
        from utils.logger import log
        log.debug(f"✅ Using cached connection info" if not force_refresh else "🔄 Refreshed connection info")
        log.debug(f"🔌 {service.capitalize()} via proxy: {host}:{port}")

        return sess

    def set_mobile_proxy(self, proxy_id: str, api_key: str) -> bool:
        """Configure the mobile proxy. Returns True on success."""
        try:
            from proxy.mobile_proxy import MobileProxyManager

            temp_proxy = MobileProxyManager(proxy_id, api_key)
            current_ip = temp_proxy.get_current_ip()
            if current_ip == "unknown":
                raise Exception("Failed to get current IP")

            stats = temp_proxy.get_stats()
            if not stats:
                raise Exception("Failed to get proxy stats")

            self.mobile_proxy = temp_proxy
            self.mobile_proxy_request_count = 0
            log.info(
                f"📱 Mobile proxy configured: {proxy_id}, IP: {current_ip}"
            )
            return True
        except Exception as e:  # pragma: no cover - configuration failure
            log.error(f"❌ Failed to configure mobile proxy: {e}")
            self.mobile_proxy = None
            return False

    def update_config(self, config):
        """Update proxy manager configuration."""
        with self.lock:
            self.config.update(config)

    def update_request_count(self, proxy_string: str) -> None:
        """Track number of requests made through the mobile proxy."""
        if proxy_string.startswith("mobile_proxy_"):
            self.mobile_proxy_request_count += 1
            log.debug(
                f"📱 Mobile proxy request count: {self.mobile_proxy_request_count}"
            )

    def _get_mobile_proxy(self) -> Optional[Dict]:
        """Return connection info for the mobile proxy without rotation."""
        if not self.mobile_proxy:
            log.warning("⚠️ Mobile proxy not configured")
            return None

        connection_info = self.mobile_proxy.get_proxy_connection_info()
        if not connection_info:
            log.error("❌ Failed to get mobile proxy connection info")
            return None

        return {
            "proxy_string": f"mobile_proxy_{self.mobile_proxy.proxy_id}",
            "host": connection_info["host"],
            "port": connection_info["port"],
            "username": connection_info["username"],
            "password": connection_info["password"],
        }

    def get_available_proxy(
        self,
        *,
        for_openai_fm: bool = True,
        for_elevenlabs: bool = False,
    ) -> Optional[Dict]:
        """Return currently available proxy (only mobile proxy supported)."""
        return self._get_mobile_proxy()

    def _get_client_ip(self) -> str:
        """Return IP address of the incoming client request."""
        if request.headers.get("X-Forwarded-For"):
            return request.headers.get("X-Forwarded-For").split(",")[0].strip()
        if request.headers.get("X-Real-IP"):
            return request.headers.get("X-Real-IP")
        return request.remote_addr or "unknown"


class ElevenLabsProxyManager(ProxyManager):
    """Backward compatibility alias."""

    pass
