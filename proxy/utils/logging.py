# -*- coding: utf-8 -*-
"""Logging utilities and colorization."""

import logging

try:  # pragma: no cover - executed only when colorlog is missing
    import colorlog
except ImportError:  # colorlog is optional
    colorlog = None


def setup_color_logging() -> logging.Logger:
    """Configure colorized logging if ``colorlog`` is available.

    Falls back to standard logging when the optional dependency is not
    installed, preventing ``ModuleNotFoundError`` during runtime.
    """

    # Ensure stdout/stderr are UTF-8 to avoid mojibake on Windows consoles
    try:
        import sys
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    if colorlog is not None:
        handler = colorlog.StreamHandler()
        handler.setFormatter(
            colorlog.ColoredFormatter(
                '%(log_color)s%(asctime)s [%(levelname)s] %(message)s',
                datefmt='%H:%M:%S',
                log_colors={
                    'DEBUG': 'cyan',
                    'INFO': 'white',
                    'WARNING': 'yellow',
                    'ERROR': 'red',
                    'CRITICAL': 'bold_red',
                },
            )
        )
        logger = logging.getLogger("proxy")
        logger.handlers.clear()
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        return logger

    # Fallback to basic logging configuration when colorlog is absent
    logger = logging.getLogger("proxy")
    logger.handlers.clear()
    handler = logging.StreamHandler()
    fmt = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
    handler.setFormatter(fmt)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger

def color_ip(ip: str, is_active: bool = False, is_unauthorized: bool = False, is_vpn: bool = False, is_local: bool = False) -> str:
    """Раскрашивает IP адрес в зависимости от статуса"""
    if is_unauthorized:
        return f"\033[91m{ip}\033[0m"
    elif is_vpn:
        return f"\033[95m{ip}\033[0m"
    elif is_local:
        return f"\033[96m{ip}\033[0m"
    elif is_active:
        return f"\033[92m{ip}\033[0m"
    else:
        return f"\033[93m{ip}\033[0m"

def log_outgoing_ip_status(actual_ip: str, proxy_host: str = None) -> str:
    """Форматирует строку для логирования текущего исходящего IP"""
    if proxy_host:
        return f"Outgoing IP: {color_ip(actual_ip, is_active=True)} via proxy {proxy_host}"
    else:
        return f"Outgoing IP: {color_ip(actual_ip, is_local=True)} (direct connection)"

def truncate_url(url: str, max_length: int = 100) -> str:
    """Сокращает URL для логирования"""
    if len(url) <= max_length:
        return url
    
    if '?' in url:
        base_url, params = url.split('?', 1)
        if len(base_url) > max_length - 10:
            return f"{base_url[:max_length-10]}...?{params[:10]}..."
        else:
            remaining = max_length - len(base_url) - 5
            return f"{base_url}?{params[:remaining]}..."
    else:
        return f"{url[:max_length-3]}..."

def log_request_short(method: str, url: str, status_code: int = None, extra: str = ""):
    """Краткое логирование запросов"""
    logger = logging.getLogger("proxy")
    short_url = truncate_url(url, 80)
    if status_code:
        logger.info(f"📡 {method} {short_url} → {status_code} {extra}")
    else:
        logger.info(f"📡 {method} {short_url} {extra}")

class ShortURLFilter(logging.Filter):
    def filter(self, record):
        return True
