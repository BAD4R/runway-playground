import time
import threading
from typing import Dict
from utils.logger import log

class Stats:
    def __init__(self):
        self.total = self.ok = self.forbidden = self.error = 0
        self.lock = threading.Lock()

    def incr(self, field):
        with self.lock:
            setattr(self, field, getattr(self, field) + 1)
            self.total += 1

    inc = incr
    
    def snapshot(self) -> Dict[str, int]:
        with self.lock:
            return {
                "total": self.total,
                "ok": self.ok,
                "403": self.forbidden,
                "error": self.error,
            }

def _stats_loop():
    while True:
        time.sleep(60)
        snap = stats.snapshot()
        if snap["total"] > 0:
            success_rate = (snap["ok"] / snap["total"]) * 100 if snap["total"] > 0 else 0
            log.info(
                "⏱  Stats | total=%d ok=%d (%.1f%%) 403=%d error=%d",
                snap["total"], snap["ok"], success_rate, snap["403"], snap["error"],
            )
            with stats.lock:
                stats.total = 0
                stats.ok = 0
                stats.forbidden = 0
                stats.error = 0

def _rate_limit_monitor():
    """Мониторинг состояния rate limiter"""
    import globals as g
    while True:
        time.sleep(60)
        if g.openai_limiter:
            stats_data = g.openai_limiter.get_stats()
            if stats_data["active_requests"] > 0 or stats_data["recent_requests"] > 0:
                log.info("📊 Rate Limiter: active=%d, recent=%d, rps=%.1f",
                        stats_data["active_requests"],
                        stats_data["recent_requests"],
                        stats_data.get("requests_per_second", 0))
# Глобальная статистика
stats = Stats()