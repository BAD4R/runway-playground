import threading
from typing import List, Tuple, Dict

import globals as g
from utils.logger import log
from services.request_handlers import execute_openai_request_parallel


class OpenAIRequestBatcher:
    """Collects incoming OpenAI requests and processes them in batches.

    Requests arriving within ``delay`` seconds are grouped into a single batch.
    The mobile proxy stats and connection info are fetched once per batch to
    avoid redundant API calls when many requests arrive simultaneously.
    """

    def __init__(self, delay: float = 3.0) -> None:
        self.delay = delay
        self._lock = threading.Lock()
        self._queue: List[Tuple[dict, dict, threading.Event, Dict]] = []
        self._timer: threading.Timer | None = None

    def enqueue(self, request_data: dict, config: dict) -> dict:
        """Add a request to the queue and wait for the batch result."""
        event = threading.Event()
        container: Dict[str, dict] = {}
        with self._lock:
            self._queue.append((request_data, config, event, container))
            # restart timer on every new request
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self.delay, self._process_batch)
            self._timer.start()
        event.wait()
        return container["response"]

    def _process_batch(self) -> None:
        with self._lock:
            batch = self._queue
            self._queue = []
            self._timer = None

        if not batch:
            return

        # Prepare proxy information once for the whole batch
        mp = getattr(getattr(g, "proxy_manager", None), "mobile_proxy", None)
        if mp:
            try:
                stats = mp.get_stats()
                mp.get_proxy_connection_info(stats)
            except Exception as exc:  # pragma: no cover - best effort
                log.error(f"❌ Failed to prepare proxy for batch: {exc}")

        threads = []

        def worker(request_data: dict, config: dict, event: threading.Event, container: Dict) -> None:
            try:
                resp = execute_openai_request_parallel(
                    request_data,
                    config=config,
                    use_limiter=config.get("use_limiter", True),
                )
                container["response"] = resp
            finally:
                event.set()

        for request_data, config, event, container in batch:
            t = threading.Thread(target=worker, args=(request_data, config, event, container), daemon=True)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()