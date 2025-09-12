# -*- coding: utf-8 -*-
"""Global logger instance and logging controls."""
import os

from .logging import setup_color_logging

# Флаг детализированного логирования (включается через переменную окружения
# ``FULL_LOGS=1``).  Когда флаг отключён, запросы и ответы логируются
# без содержимого.
FULL_LOGS = os.environ.get("FULL_LOGS", "0") == "1"

# Глобальный логгер
log = setup_color_logging()


def maybe_truncate(text: str, limit: int) -> str:
    """Return full text when FULL_LOGS enabled, else truncate to ``limit`` chars."""
    if text is None or FULL_LOGS:
        return text
    return text if len(text) <= limit else text[:limit] + "..."

# Экспортируем для удобства
__all__ = ["log", "FULL_LOGS", "maybe_truncate"]
