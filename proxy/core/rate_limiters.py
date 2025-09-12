# -*- coding: utf-8 -*-
"""Rate limiting implementations for different services"""
import time
import threading
from collections import defaultdict
from threading import Condition
from typing import Dict
from utils.logger import log
from config.global_params import load_openai_limits


class OpenAIRateLimiter:
    """Rate limiter for OpenAI API requests.

    The limits for each model are loaded from ``globalParams.json``.
    Supported limits per model:
        - ``rpm``  – requests per minute
        - ``rpd``  – requests per day
        - ``tmp``  – tokens per minute
        - ``tpd``  – tokens per day

    If a model is not found in the config, the ``default`` limits are used.
    """

    def __init__(self, limits: Dict[str, Dict[str, int]] = None):
        self.model_limits = limits or load_openai_limits()
        self.usage = defaultdict(lambda: {"requests": [], "tokens": []})
        self.active_requests = 0
        self.lock = threading.Lock()
        self.condition = Condition(self.lock)
        # optional queue timeout (None = wait indefinitely)
        self.queue_timeout = None

    def update_config(self, config):
        """Update limiter configuration."""
        with self.lock:
            if "queue_timeout" in config:
                self.queue_timeout = config["queue_timeout"]

    def reload_limits(self) -> None:
        """Reload model limits from the global parameters file."""
        with self.lock:
            self.model_limits = load_openai_limits() or {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _get_limits(self, model: str) -> Dict[str, int]:
        limits = self.model_limits.get(model)
        if not limits:
            for key, val in self.model_limits.items():
                if model in key:
                    limits = val
                    break
        if not limits:
            limits = self.model_limits.get("default", {})
        result = {}
        for key, value in limits.items():
            result[key] = float("inf") if value in (0, None) else int(value)
        return result

    def _prune_model(self, model: str) -> None:
        """Remove outdated usage entries for a model."""
        now = time.time()
        usage = self.usage[model]
        # keep last 24h for requests/tokens
        usage["requests"] = [t for t in usage["requests"] if now - t < 86400]
        usage["tokens"] = [(t, tok) for t, tok in usage["tokens"] if now - t < 86400]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def _compute_wait_seconds(self, model: str, tokens: int) -> float:
        """Compute precise seconds to wait until ``model`` can start.

        Considers rpm/rpd/tmp/tpd limits and current active concurrency.
        Returns 0.0 if it can start immediately. Returns ``inf`` if blocked
        by unknown factors.
        """
        limits = self._get_limits(model)
        self._prune_model(model)
        usage = self.usage[model]
        now = time.time()

        # Build windows
        req_last_minute = [t for t in usage["requests"] if now - t < 60]
        req_last_day = usage["requests"]  # already pruned to 24h
        tok_last_minute = [(t, tok) for t, tok in usage["tokens"] if now - t < 60]
        tok_last_day = usage["tokens"]  # already pruned to 24h

        waits = [0.0]

        # rpm
        rpm = limits.get("rpm", float("inf"))
        if rpm != float("inf") and len(req_last_minute) >= rpm:
            # Need the oldest of the last-minute entries that contributes to overflow to expire
            kth_oldest = sorted(req_last_minute)[len(req_last_minute) - int(rpm)]
            waits.append((kth_oldest + 60.0) - now)

        # rpd (requests per day)
        rpd = limits.get("rpd", float("inf"))
        if rpd != float("inf") and len(req_last_day) >= rpd:
            oldest = min(req_last_day)
            waits.append((oldest + 86400.0) - now)

        # tmp (tokens per minute)
        tmp = limits.get("tmp", float("inf"))
        if tmp != float("inf"):
            minute_tokens = sum(tok for _, tok in tok_last_minute)
            need = minute_tokens + max(0, int(tokens)) - tmp
            if need > 0:
                # Drop oldest minute tokens until we free >= need
                freed = 0
                for t, tok in sorted(tok_last_minute, key=lambda x: x[0]):
                    freed += tok
                    if freed >= need:
                        waits.append((t + 60.0) - now)
                        break

        # tpd (tokens per day)
        tpd = limits.get("tpd", float("inf"))
        if tpd != float("inf"):
            day_tokens = sum(tok for _, tok in tok_last_day)
            need = day_tokens + max(0, int(tokens)) - tpd
            if need > 0:
                freed = 0
                for t, tok in sorted(tok_last_day, key=lambda x: x[0]):
                    freed += tok
                    if freed >= need:
                        waits.append((t + 86400.0) - now)
                        break

        wait = max(waits) if waits else 0.0
        return max(0.0, wait)

    def suggest_wait_seconds(self, model: str, tokens: int = 0) -> float:
        """Public helper to compute an estimated wait before a slot is free."""
        with self.condition:
            return self._compute_wait_seconds(model, tokens)

    def acquire_slot(self, model: str, tokens: int = 0, timeout: float = None) -> bool:
        """Attempt to acquire a processing slot for ``model``.

        ``tokens`` is a best-effort estimate of tokens that will be used.
        Returns ``True`` if a slot is acquired before ``timeout`` expires.
        If ``timeout`` <= 0, waits indefinitely according to limits.
        """
        if timeout is None:
            timeout = self.queue_timeout

        with self.condition:
            start = time.time()
            deadline = float("inf") if (timeout is None or timeout <= 0) else (start + timeout)

            while True:
                limits = self._get_limits(model)
                self._prune_model(model)
                usage = self.usage[model]
                now = time.time()

                # Calculate current usage
                minute_requests = sum(1 for t in usage["requests"] if now - t < 60)
                day_requests = len(usage["requests"])
                minute_tokens = sum(tok for t, tok in usage["tokens"] if now - t < 60)
                day_tokens = sum(tok for _, tok in usage["tokens"])

                can_start = (
                    minute_requests < limits.get("rpm", float("inf")) and
                    day_requests < limits.get("rpd", float("inf")) and
                    minute_tokens + tokens <= limits.get("tmp", float("inf")) and
                    day_tokens + tokens <= limits.get("tpd", float("inf"))
                )

                if can_start:
                    usage["requests"].append(now)
                    usage["tokens"].append((now, tokens))
                    self.active_requests += 1
                    return True

                remaining = deadline - time.time()
                if remaining <= 0:
                    return False

                precise_wait = self._compute_wait_seconds(model, tokens)
                wait_time = min(remaining, max(0.05, precise_wait))
                self.condition.wait(timeout=wait_time)

    def record_usage(self, model: str, tokens: int, estimated: int = 0) -> None:
        """Record the actual ``tokens`` used for ``model``.

        ``estimated`` should match the value passed to :meth:`acquire_slot`.
        If actual usage exceeds the estimate, the difference is added.
        """
        diff = tokens - estimated
        if diff <= 0:
            return
        with self.condition:
            self._prune_model(model)
            self.usage[model]["tokens"].append((time.time(), diff))
            self.condition.notify_all()

    def release_slot(self) -> None:
        """Освободить слот и уведомить ожидающих"""
        with self.condition:
            if self.active_requests > 0:
                self.active_requests -= 1
            self.condition.notify_all()

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------
    def get_stats(self) -> dict:
        """Получить общую статистику лимитера"""
        with self.lock:
            now = time.time()
            recent_requests = 0
            for usage in self.usage.values():
                recent_requests += sum(1 for t in usage["requests"] if now - t < 60)
            return {
                "recent_requests": recent_requests,
                "active_requests": self.active_requests,
                "requests_per_second": recent_requests / 60.0 if recent_requests else 0,
            }

    def get_detailed_stats(self, model: str) -> dict:
        """Получить детальную статистику для конкретной модели"""
        with self.lock:
            self._prune_model(model)
            usage = self.usage[model]
            now = time.time()
            minute_requests = sum(1 for t in usage["requests"] if now - t < 60)
            minute_tokens = sum(tok for t, tok in usage["tokens"] if now - t < 60)
            return {
                "recent_requests": minute_requests,
                "recent_tokens": minute_tokens,
                "active_requests": self.active_requests,
            }

class ElevenLabsRateLimiter:
    """Placeholder for backward compatibility.

    The actual rate limiting for ElevenLabs is handled elsewhere, so this
    class no longer imposes delays or retry caps.
    """

    def update_config(self, config):
        pass

    def wait_for_rate_limit(self):
        pass
