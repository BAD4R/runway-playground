# -*- coding: utf-8 -*-
"""
Request processing handlers for different services
"""
import time
import json
import random
import re
import requests
from requests.exceptions import ReadTimeout, ConnectionError as RequestsConnectionError

import globals as g
from utils.logger import log, FULL_LOGS, maybe_truncate
from config.settings import get_openai_config
from utils.logging import color_ip

def get_global_objects():
    """Poluchaet globalnye obekty iz main modulya"""
    import main
    return {
        'openai_limiter': main.openai_limiter,
        'stats': main.stats,
        'proxy_manager': main.proxy_manager,
        'elevenlabs_manager': main.elevenlabs_manager,
        'elevenlabs_rate_limiter': main.elevenlabs_rate_limiter
    }

# V fayle: services/request_handlers.py

def execute_openai_request_parallel(request_data: dict, max_wait: int = None, config: dict = None, retry_count: int = 0, use_limiter: bool = True) -> dict:
    """Vypolnyaet zapros k OpenAI s ocheredyu, proksi, retrayami, rotatsiey IP
    i korrektnym ozhidaniem pri 429 — slot osvobozhdaetsya PERED sleep.
    """
    import time
    import json
    import random
    import datetime
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    from requests.exceptions import ProxyError, ConnectionError, Timeout, ReadTimeout, ConnectTimeout, SSLError, ChunkedEncodingError
    from email.utils import parsedate_to_datetime
    import re
    import globals as g
    from utils.logger import log, FULL_LOGS, maybe_truncate
    from config.settings import get_openai_config

    def _redact_headers(h: dict) -> dict:
        h = dict(h or {})
        if not FULL_LOGS and "Authorization" in h and isinstance(h["Authorization"], str):
            val = h["Authorization"]
            h["Authorization"] = (val[:14] + "...(redacted)") if len(val) > 20 else "Bearer ***"
        return h

    def _parse_retry_after(resp) -> float:
        """Vozvrashchaet rekomenduemuyu zaderzhku (sek) iz Retry-After (sek/data) ili tekstovki oshibki. Follbek — 2.0s."""
        ra = None
        for k, v in resp.headers.items():
            if k.lower() == "retry-after":
                ra = v.strip()
                break
        if ra:
            if re.fullmatch(r"\d+", ra):
                try:
                    return max(1.0, float(int(ra)))
                except Exception:
                    pass
            try:
                dt = parsedate_to_datetime(ra)
                if resp.headers.get("date"):
                    base = parsedate_to_datetime(resp.headers["date"])
                else:
                    base = datetime.datetime.utcnow().replace(tzinfo=dt.tzinfo)
                delta = (dt - base).total_seconds()
                if delta and delta > 0:
                    return float(delta)
            except Exception:
                pass

        try:
            body = resp.json()
            msg = body.get("error", {}).get("message", "") if isinstance(body, dict) else ""
            if msg:
                m = re.search(r"after\s+([\d.]+)\s*seconds", msg, re.IGNORECASE)
                if m:
                    return max(1.0, float(m.group(1)))
                m = re.search(r"in\s+(\d+)\s*ms", msg, re.IGNORECASE)
                if m:
                    return max(0.5, int(m.group(1)) / 1000.0)
                m = re.search(r"in\s+([\d.]+)\s*s\b", msg, re.IGNORECASE)
                if m:
                    return max(1.0, float(m.group(1)))
        except Exception:
            pass

        return 2.0

    if config is None:
        config = get_openai_config()
    if max_wait is None:
        max_wait = None
    start_time = time.time()

    # opredelit model i priblizitelnoe kolichestvo tokenov
    body = request_data.get("body") or {}
    model = body.get("model", "default") if isinstance(body, dict) else "default"
    estimated_tokens = 0
    if isinstance(body, dict):
        estimated_tokens = body.get("max_tokens") or body.get("max_output_tokens") or 0

    acquired = False
    if use_limiter:
        # ochered/limiter
        g.openai_limiter.update_config(config)
        acquired = g.openai_limiter.acquire_slot(model=model, tokens=estimated_tokens, timeout=max_wait)
        if not acquired:
            # Smart behavior: do not extend queue timeouts recursively.
            # Instead compute precise wait suggestion and return 429 with Retry-After.
            suggested = g.openai_limiter.suggest_wait_seconds(model=model, tokens=estimated_tokens)
            retry_after = max(1, int(suggested)) if suggested and suggested != float('inf') else 2
            log.warning(" OpenAI slot unavailable; suggest retry after %ss (model=%s)", retry_after, model)
            payload = {"error": "Rate limited", "retry_after_seconds": retry_after, "model": model}
            return {
                "content": json.dumps(payload).encode("utf-8"),
                "status_code": 429,
                "headers": {"Retry-After": str(retry_after)},
            }

    session = None
    slot_released_early = False
    
    try:
        slot_wait_time = time.time() - start_time
        log.debug("✅ OpenAI slot acquired after %.2fs", slot_wait_time)

        session = requests.Session()
        session.trust_env = False  # ignor sistemnykh proksi
        proxy_obj = None
        if g.proxy_manager:
            proxy_obj = g.proxy_manager.get_available_proxy(for_openai_fm=True)
        if not proxy_obj:
            log.error("❌ No proxy available for OpenAI")
            return {
                "content": json.dumps({"error": "Proxy unavailable"}).encode("utf-8"),
                "status_code": 503,
                "headers": {},
            }

        proxy_url = f"http://{proxy_obj['username']}:{proxy_obj['password']}@{proxy_obj['host']}:{proxy_obj['port']}"
        session.proxies.update({"http": proxy_url, "https": proxy_url})
        log.debug("🔌 OpenAI via proxy: %s", proxy_obj["host"])
        retry = Retry(
            total=2, connect=2, read=2, status=2,
            backoff_factor=0.7,
            status_forcelist=[429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
            allowed_methods=None,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=50)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        url = request_data.get("url") or "https://api.openai.com/v1/chat/completions"
        method = request_data.get("method", "POST").upper()

        if FULL_LOGS:
            log.info("📤 OpenAI Request: %s %s", method, url)
            log.info("📤 Headers: %s", json.dumps(_redact_headers(request_data.get("headers", {})), indent=2, ensure_ascii=False))
            if request_data.get("body") is not None:
                body_str = json.dumps(request_data["body"], indent=2, ensure_ascii=False)
                # if len(body_str) > 1000:
                    # body_str = body_str[:1000] + "... (truncated)"
                log.info("📤 Body: %s", body_str)
        else:
            log.info("📤 OpenAI Request: %s %s", method, url)
        request_start = time.time()
        resp = session.request(
            method,
            url,
            headers=request_data.get("headers", {}),
            json=request_data.get("body", None),
        )
        request_duration = time.time() - request_start
        if FULL_LOGS:
            log.info("📥 OpenAI Response: %d (took %.2fs)", resp.status_code, request_duration)
            # log otveta (bezopasno)
            try:
                if resp.headers.get('content-type', '').startswith('application/json'):
                    response_text = resp.text
                    # if len(response_text) > 2000:
                        # response_text = response_text[:2000] + ". (truncated)"
                    log.info("📥 Response Body: %s", response_text)
                else:
                    log.info("📥 Response Body: Non-JSON content, size: %d bytes", len(resp.content))
            except Exception:
                log.info("📥 Response Body: Could not decode response")
        else:
            log.info("📥 OpenAI Response: %d", resp.status_code)

        # obnovlyaem ispolzovanie tokenov tolko pri uspeshnom otvete
        if resp.status_code < 400 and use_limiter:
            try:
                resp_json = resp.json()
                usage = resp_json.get("usage", {}) if isinstance(resp_json, dict) else {}
                total_tokens = usage.get("total_tokens")
                if total_tokens is not None:
                    g.openai_limiter.record_usage(model, int(total_tokens), estimated_tokens)
            except Exception:
                pass

        # === 429: zhdem, NO SLOT SNAChALA OTPUSKAEM ===
        if resp.status_code == 429:
            retry_seconds = _parse_retry_after(resp)
            max_backoff = float(config.get('max_backoff_seconds', 120.0))
            # legkiy dzhitter + kap
            retry_seconds = max(1.0, min(retry_seconds + random.uniform(0, 1.5), max_backoff))

            log.warning("🛑 429 from OpenAI. Will wait %.2fs (retry=%d).", retry_seconds, retry_count)
            if use_limiter and acquired and not slot_released_early:
                g.openai_limiter.release_slot()
                slot_released_early = True
                log.debug("🔓 OpenAI slot released early (429)")

            time.sleep(retry_seconds)

            return execute_openai_request_parallel(request_data, max_wait, config, retry_count + 1)

        # 5xx — kratkovremennye oshibki: tozhe ne derzhim slot vo vremya pauzy
        if resp.status_code in (500, 502, 503, 504):
            backoff = min(10.0 * (retry_count + 1), 30.0) + random.uniform(0, 1.0)
            log.warning("⚠️ OpenAI %d. Backoff %.1fs, retry=%d", resp.status_code, backoff, retry_count)
            if use_limiter and acquired and not slot_released_early:
                g.openai_limiter.release_slot()
                slot_released_early = True
                log.debug("🔓 OpenAI slot released early (5xx)")
            time.sleep(backoff)
            return execute_openai_request_parallel(request_data, max_wait, config, retry_count + 1)

        # obychnyy otvet
        return {"content": resp.content, "status_code": resp.status_code, "headers": dict(resp.headers)}

    except (Timeout, ReadTimeout, ConnectTimeout):
        log.error("❌ OpenAI request timeout")
        backoff = min(5.0 * (retry_count + 1), 20.0) + random.uniform(0, 1.0)
        if use_limiter and acquired and not slot_released_early:
            g.openai_limiter.release_slot()
            slot_released_early = True
            log.debug("🔓 OpenAI slot released early (timeout)")
        time.sleep(backoff)
        return execute_openai_request_parallel(request_data, max_wait, config, retry_count + 1)

    except (ProxyError, ConnectionError, SSLError, ChunkedEncodingError, ConnectionResetError) as e:
        log.error("❌ OpenAI connection/proxy error: %s", maybe_truncate(str(e), 200))
        try:
            if getattr(g.proxy_manager, "mobile_proxy", None):
                log.info("🔁 Rotating mobile proxy IP due to connection error …")
                g.proxy_manager.mobile_proxy.rotate_ip()
        except Exception as re:
            log.warning("⚠️ IP rotation failed: %s", re)

        backoff = min(5.0 * (retry_count + 1), 20.0) + random.uniform(0, 1.0)
        if use_limiter and acquired and not slot_released_early:
            g.openai_limiter.release_slot()
            slot_released_early = True
            log.debug("🔓 OpenAI slot released early (conn error)")
        time.sleep(backoff)

        return execute_openai_request_parallel(request_data, max_wait, config, retry_count + 1)

    except Exception as e:
        log.error("❌ OpenAI request error: %s", maybe_truncate(str(e), 200))
        backoff = 5.0 + random.uniform(0, 1.0)
        if use_limiter and acquired and not slot_released_early:
            g.openai_limiter.release_slot()
            slot_released_early = True
            log.debug("🔓 OpenAI slot released early (generic error)")
        time.sleep(backoff)
        return execute_openai_request_parallel(request_data, max_wait, config, retry_count + 1)

    finally:
        try:
            if use_limiter and acquired and not slot_released_early:
                g.openai_limiter.release_slot()
                log.debug("🔓 OpenAI slot released")
        except Exception:
            pass
        try:
            if session:
                session.close()
        except Exception:
            pass


def _get_elevenlabs_audio_content(text: str, voice_id: str, config: dict, retry_count: int = 0):
    """Poluchenie audio kontenta cherez ElevenLabs API"""
    
    # Primenyaem rate limiting, osnovannyy na global params
    
    # Proveryaem dlinu teksta
    if len(text) > 5000:
        log.error("❌ Text too long for ElevenLabs: %d characters", len(text))
        return None, 400, {"error": "Text too long"}
    
    # Poluchaem luchshiy API klyuch S ROTATsEY IP
    api_data = elevenlabs_manager.get_best_api_key(len(text), rotate_ip=True)
    if not api_data:
        log.error("❌ No available API key for ElevenLabs")
        return None, 503, {"error": "No available API key"}

    
    # spolzuem mobilnyy proksi esli nastroen
    if elevenlabs_manager.mobile_proxy:
        current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()

        # Esli rotatsiya eshche ne zavershena - zhdem ee okonchaniya
        if current_ip in ("rotation_in_progress", "unknown"):
            log.warning("⚠️ Proxy rotation in progress, waiting before request")
            if not elevenlabs_manager.mobile_proxy.wait_for_rotation_complete(max_wait=60):
                log.error("❌ Proxy rotation did not complete, attempting re-rotation")
                if not elevenlabs_manager.mobile_proxy.rotate_ip() or not elevenlabs_manager.mobile_proxy.wait_for_rotation_complete(max_wait=60):

                    return None, 503, {"error": "Proxy rotation failed"}
            current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()
            if current_ip in ("rotation_in_progress", "unknown"):
                return None, 503, {"error": "Proxy IP unavailable"}

        proxy_info = elevenlabs_manager.mobile_proxy.get_proxy_connection_info()
        if proxy_info:
            proxy_dict = {
                "http": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}",
                "https": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}",
            }
            request_ip = current_ip
            proxy_type = "mobile"
        else:
            log.error("❌ Failed to get mobile proxy connection info")
            return None, 503, {"error": "Mobile proxy connection info unavailable"}
    else:
        temp_proxy_obj = proxy_manager.get_available_proxy(for_elevenlabs=True)
        if not temp_proxy_obj:
            log.warning("⚠️ No proxy available for ElevenLabs")
            return None, 503, {"error": "No proxy available"}
        proxy_dict = elevenlabs_manager._get_proxy_dict(temp_proxy_obj)
        request_ip = temp_proxy_obj['host']
        proxy_type = "regular"

    log.info(f"🎤 ElevenLabs request: voice={voice_id}, text_len={len(text)}, account={api_data.get('email', 'unknown')}, proxy_type={proxy_type}, IP={request_ip}")        
    

    # One-time cleanup of custom voices per account to avoid voice_limit_reached
    try:
        if hasattr(elevenlabs_manager, 'ensure_account_voices_cleaned'):
            elevenlabs_manager.ensure_account_voices_cleaned(api_data['api_key'], api_data.get('email'), proxy_dict)
        else:
            if api_data.get('email') and api_data.get('email') not in getattr(elevenlabs_manager, 'cleaned_accounts', set()):
                elevenlabs_manager._cleanup_elevenlabs_voices_for(api_data['api_key'], api_data.get('email'))
                try:
                    elevenlabs_manager.cleaned_accounts.add(api_data.get('email'))
                except Exception:
                    pass
    except Exception as _cleanup_err:
        log.warning(f"Cleanup before request failed (continuing): {_cleanup_err}")

    # Ensure voices cleanup before retry with same account too
    try:
        if hasattr(elevenlabs_manager, 'ensure_account_voices_cleaned'):
            elevenlabs_manager.ensure_account_voices_cleaned(api_data['api_key'], api_data.get('email'), proxy_dict)
        else:
            if api_data.get('email') and api_data.get('email') not in getattr(elevenlabs_manager, 'cleaned_accounts', set()):
                elevenlabs_manager._cleanup_elevenlabs_voices_for(api_data['api_key'], api_data.get('email'))
                try:
                    elevenlabs_manager.cleaned_accounts.add(api_data.get('email'))
                except Exception:
                    pass
    except Exception:
        pass

    try:
        session = requests.Session()
        session.trust_env = False
        session.proxies = proxy_dict
        
        # Formiruem zapros
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        
        # Dobavlyaem randomnye zagolovki kak dlya OpenAI FM
        headers = random_headers()
        headers.update({
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": api_data['api_key']
        })
        
        payload = {
            "text": text,
            "model_id": config.get('model_id', 'eleven_multilingual_v2'),
            "voice_settings": {
                "stability": config.get('stability', 0.5),
                "similarity_boost": config.get('similarity_boost', 0.5),
                "style": config.get('style', 0.5),
                "use_speaker_boost": config.get('use_speaker_boost', True)
            }
        }

        try:
            response = session.post(
                url,
                json=payload,
                headers=headers,
            )
            elevenlabs_manager.update_quota_after_request(
                api_data['api_key'],
                len(text),
                config.get('model_id', elevenlabs_manager.config.get('model_id'))
            )
        except (ReadTimeout, RequestsConnectionError) as e:
            log.error(f"❌ Proxy connection error for ElevenLabs: {e}")
            session.close()
            if elevenlabs_manager.mobile_proxy:
                log.info("🔄 Rotating IP after connection error")
                elevenlabs_manager.mobile_proxy.rotate_ip()
            time.sleep(5)
            return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)

        if response.status_code == 200:
            content = response.content
            session.close()

            
            # Obnovlyaem ispolzovanie
            elevenlabs_manager.update_usage(api_data['api_key'], len(text))
            # Dlya mobilnogo proksi ne obnovlyaem schetchik ElevenLabs proksi
            if proxy_type == "regular" and 'temp_proxy_obj' in locals():
                proxy_manager.update_elevenlabs_request_count(temp_proxy_obj['proxy_string'])       
            
            log.info("✅ ElevenLabs audio generated: %d bytes", len(content))
            return content, 200, {"Content-Type": "audio/mpeg"}

            
        elif response.status_code == 401:
            # Detalnyy analiz oshibki 401
            try:
                error_data = response.json()
                error_detail = error_data.get('detail', {})
                error_status = error_detail.get('status', 'unknown')
                error_message = error_detail.get('message', 'Unknown error')

                log.error(
                    "❌ ElevenLabs 401 Error - Status: %s, Message: %s, Email: %s",
                    error_status,
                    error_message,
                    api_data['email'],
                )

                if error_status == 'quota_exceeded':
                    # Kvota ischerpana
                    message = error_detail.get('message', '')
                    remaining = 0
                    try:
                        match = re.search(r'You have (\d+) credits remaining', message)
                        if match:
                            remaining = int(match.group(1))
                    except Exception:
                        pass
                    elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                    session.close()
                    time.sleep(5)
                    return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)

                # Spetsialnaya obrabotka dlya unusual activity
                                # Unusual activity branch
                if error_status == 'detected_unusual_activity':
                    session.close()
                    account_retry_count = getattr(api_data, '_retry_count', 0) + 1
                    log.warning(
                        f"Unusual activity detected on {api_data['email']} - attempt {account_retry_count}/4"
                    )
                    if account_retry_count >= 4:
                        elevenlabs_manager.mark_unusual_activity(
                            api_data['api_key'], api_data['email'], account_retry_count
                        )
                        log.warning(
                            f"Account {api_data['email']} disabled after 4 attempts - switching to next account"
                        )
                        return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)
                    else:
                        api_data['_retry_count'] = account_retry_count
                        if elevenlabs_manager.mobile_proxy:
                            log.info(
                                f"Forcing IP rotation before retry {account_retry_count}/4"
                            )
                            if not elevenlabs_manager.mobile_proxy.can_rotate_now():
                                log.info(
                                    "Waiting for current rotation to complete before forced IP rotation"
                                )
                                elevenlabs_manager.mobile_proxy.wait_for_rotation_complete(max_wait=60)
                            success = elevenlabs_manager.mobile_proxy.rotate_ip()
                            if success:
                                log.info(f"IP rotated before retry {account_retry_count}/4")
                            else:
                                log.warning("IP rotation failed, continuing with current IP")
                        time.sleep(10)
                        return _retry_with_same_account(text, voice_id, config, api_data)          # Vse ostalnye oshibki 401
                session.close()
                return None, 401, {"error": f"API key error: {error_status}"}

            except json.JSONDecodeError:
                log.error(
                    "❌ ElevenLabs API key invalid (cannot parse error): %s",
                    api_data['email'],
                )
                session.close()
                return None, 401, {"error": "Invalid API key"}
            
        elif response.status_code == 403:
            if proxy_type == "regular" and 'temp_proxy_obj' in locals():
                log.error("❌ ElevenLabs proxy banned: %s", temp_proxy_obj['host'])
                proxy_manager.mark_elevenlabs_proxy_banned(temp_proxy_obj['proxy_string'], "403 Forbidden")
            else:
                log.error("❌ ElevenLabs mobile proxy banned")
            session.close()
            
            time.sleep(30)
            return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)
            
        elif response.status_code == 429:
            log.warning("⚠️ ElevenLabs rate limit hit")
            session.close()

            time.sleep(60)
            return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)

        else:
            try:
                error_data = response.json()
                detail = error_data.get('detail', {})
                if detail.get('status') == 'quota_exceeded':
                    message = detail.get('message', '')
                    remaining = 0
                    try:
                        match = re.search(r'You have (\d+) credits remaining', message)
                        if match:
                            remaining = int(match.group(1))
                    except Exception:
                        pass
                    elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                    session.close()
                    time.sleep(5)
                    return _get_elevenlabs_audio_content(text, voice_id, config, retry_count + 1)
            except Exception:
                pass
            log.error("❌ ElevenLabs API error: %d - %s", response.status_code, maybe_truncate(response.text, 200))
            # If voice limit is reached, cleanup and retry once with same account
            try:
                data = response.json()
                detail = (data or {}).get('detail', {}) if isinstance(data, dict) else {}
                if response.status_code == 400 and isinstance(detail, dict) and detail.get('status') == 'voice_limit_reached':
                    try:
                        if hasattr(elevenlabs_manager, 'ensure_account_voices_cleaned'):
                            elevenlabs_manager.ensure_account_voices_cleaned(api_data['api_key'], api_data.get('email'), proxy_dict)
                        else:
                            elevenlabs_manager._cleanup_elevenlabs_voices_for(api_data['api_key'], api_data.get('email'))
                    except Exception:
                        pass
                    session.close()
                    time.sleep(2)
                    return _retry_with_same_account(text, voice_id, config, api_data)
            except Exception:
                pass
            session.close()
            return None, response.status_code, {"error": response.text}
            
    except Exception as e:
        log.error("❌ ElevenLabs request failed: %s", e)
        if 'session' in locals():
            session.close()
        return None, 500, {"error": str(e)}

def _retry_with_same_account(text: str, voice_id: str, config: dict, api_data: dict):
    """Povtoryaet zapros s tem zhe akkauntom posle rotatsii IP"""
    
    # Poluchaem svezhie dannye proksi posle rotatsii
    if elevenlabs_manager.mobile_proxy:
        current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()
        if current_ip in ("rotation_in_progress", "unknown"):
            log.warning("⚠️ Proxy rotation in progress, waiting before retry")
            if not elevenlabs_manager.mobile_proxy.wait_for_rotation_complete(max_wait=60):
                return None, 503, {"error": "Proxy IP unavailable"}
            current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()
            if current_ip in ("rotation_in_progress", "unknown"):
                return None, 503, {"error": "Proxy IP unavailable"}

        proxy_info = elevenlabs_manager.mobile_proxy.get_proxy_connection_info()
        if proxy_info:
            proxy_dict = {
                "http": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}",
                "https": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}"
            }
            request_ip = current_ip
            proxy_type = "mobile"
        else:
            return None, 503, {"error": "Mobile proxy connection info unavailable"}
    else:
        return None, 503, {"error": "No mobile proxy available"}

    retry_count = api_data.get('_retry_count', 1)
    log.info(f"🔄 Retrying with same account after IP rotation: {api_data['email']}, attempt {retry_count}/4, IP={request_ip}")
    
    try:
        session = requests.Session()
        session.trust_env = False
        session.proxies = proxy_dict
        
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        
        headers = random_headers()
        headers.update({
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": api_data['api_key']
        })
        
        payload = {
            "text": text,
            "model_id": config.get('model_id', 'eleven_multilingual_v2'),
            "voice_settings": {
                "stability": config.get('stability', 0.5),
                "similarity_boost": config.get('similarity_boost', 0.5),
                "style": config.get('style', 0.5),
                "use_speaker_boost": config.get('use_speaker_boost', True)
            }
        }

        try:
            response = session.post(
                url, json=payload, headers=headers
            )
            elevenlabs_manager.update_quota_after_request(
                api_data['api_key'],
                len(text),
                config.get('model_id', elevenlabs_manager.config.get('model_id'))
            )
        except (ReadTimeout, RequestsConnectionError) as e:
            log.error(f"❌ Proxy connection error during retry: {e}")
            session.close()
            if elevenlabs_manager.mobile_proxy:
                elevenlabs_manager.mobile_proxy.rotate_ip()
            time.sleep(5)
            return _retry_with_same_account(text, voice_id, config, api_data)

        if response.status_code == 200:
            content = response.content
            session.close()
            
            elevenlabs_manager.update_usage(api_data['api_key'], len(text))
            log.info(f"✅ Success after IP rotation: {api_data['email']}, attempt {retry_count}/4")
            return content, 200, {"Content-Type": "audio/mpeg"}
            
        elif response.status_code == 401:
            error_data = response.json()
            error_detail = error_data.get('detail', {})
            error_status = error_detail.get('status', 'unknown')

            if error_status == 'quota_exceeded':
                message = error_detail.get('message', '')
                remaining = 0
                try:
                    match = re.search(r'You have (\d+) credits remaining', message)
                    if match:
                        remaining = int(match.group(1))
                except Exception:
                    pass
                elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                session.close()
                time.sleep(5)
                return _retry_with_same_account(text, voice_id, config, api_data)

            if error_status == 'detected_unusual_activity':
                session.close()
                # Rekursivno vyzyvaem osnovnuyu funktsiyu dlya obrabotki
                return _get_elevenlabs_audio_content(text, voice_id, config, 0)
            else:
                session.close()
                return None, 401, {"error": f"API key error: {error_status}"}
        else:
            try:
                error_data = response.json()
                detail = error_data.get('detail', {})
                if detail.get('status') == 'quota_exceeded':
                    message = detail.get('message', '')
                    remaining = 0
                    try:
                        match = re.search(r'You have (\d+) credits remaining', message)
                        if match:
                            remaining = int(match.group(1))
                    except Exception:
                        pass
                    elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                    session.close()
                    time.sleep(5)
                    return _retry_with_same_account(text, voice_id, config, api_data)
            except Exception:
                pass
            session.close()
            return None, response.status_code, {"error": response.text}
            
    except Exception as e:
        if 'session' in locals():
            session.close()
        return None, 500, {"error": str(e)}

def _handle_unusual_activity_retry(text: str, voice_id: str, config: dict, base_retry_count: int = 0):
    """Spetsialnaya obrabotka dlya oshibki unusual activity s rotatsiey IP"""
    max_unusual_retries = 150
    retry_delay = 10
    
    for unusual_retry in range(max_unusual_retries):  # ← unusual_retry obyavlyaetsya zdes
        log.info(f"🔄 Unusual activity retry {unusual_retry + 1}/{max_unusual_retries}")  # ← ispolzuetsya zdes - OK
        
        # Zhdem pered povtornoy popytkoy
        time.sleep(retry_delay)
        
        # spolzuem mobilnyy proksi esli nastroen
        # spolzuem mobilnyy proksi esli nastroen
        # spolzuem mobilnyy proksi esli nastroen
        if elevenlabs_manager.mobile_proxy:
            current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()
            if current_ip in ("rotation_in_progress", "unknown"):
                log.warning("⚠️ Proxy rotation in progress, waiting...")
                if not elevenlabs_manager.mobile_proxy.wait_for_rotation_complete(max_wait=60):
                    return None, 503, {"error": "Proxy IP unavailable"}
                current_ip = elevenlabs_manager.mobile_proxy.get_current_ip()
                if current_ip in ("rotation_in_progress", "unknown"):
                    return None, 503, {"error": "Proxy IP unavailable"}

            proxy_info = elevenlabs_manager.mobile_proxy.get_proxy_connection_info()
            if proxy_info:
                proxy_dict = {
                    "http": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}",
                    "https": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}"
                }
                request_ip = current_ip
                proxy_server = f"{proxy_info['host']}:{proxy_info['port']}"
                proxy_type = "mobile"
            else:
                log.error("❌ Failed to get mobile proxy connection info")
                return None, 503, {"error": "Mobile proxy connection info unavailable"}
  
        else:
            temp_proxy_obj = proxy_manager.get_available_proxy(for_elevenlabs=True)
            if not temp_proxy_obj:
                log.warning("⚠️ No proxy available for ElevenLabs")
                return None, 503, {"error": "No proxy available"}
            proxy_dict = elevenlabs_manager._get_proxy_dict(temp_proxy_obj)
            request_ip = temp_proxy_obj['host']
            proxy_type = "regular"

        log.info(f"🎤 ElevenLabs request: voice={voice_id}, text_len={len(text)}, account={api_data.get('email', 'unknown')}, proxy_type={proxy_type}, IP={request_ip}")       
        # Poluchaem API klyuch snova S ROTATsEY
        api_data = elevenlabs_manager.get_best_api_key(len(text), rotate_ip=True)

        if not api_data:
            log.error("❌ No API key available for unusual activity retry")
            return None, 503, {"error": "No available API key"}
        
        proxy_dict = elevenlabs_manager._get_proxy_dict(proxy_obj)
        
        try:
            session = requests.Session()
            session.trust_env = False
            session.proxies = proxy_dict
            
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
            
            headers = random_headers()
            headers.update({
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
                "xi-api-key": api_data['api_key']
            })
            
            payload = {
                "text": text,
                "model_id": config.get('model_id', 'eleven_multilingual_v2'),
                "voice_settings": {
                    "stability": config.get('stability', 0.5),
                    "similarity_boost": config.get('similarity_boost', 0.5),
                    "style": config.get('style', 0.5),
                    "use_speaker_boost": config.get('use_speaker_boost', True)
                }
            }

            try:
                response = session.post(
                    url,
                    json=payload,
                    headers=headers,
                )
                elevenlabs_manager.update_quota_after_request(
                    api_data['api_key'],
                    len(text),
                    config.get('model_id', elevenlabs_manager.config.get('model_id'))
                )
            except (ReadTimeout, RequestsConnectionError) as e:
                log.error(f"❌ Proxy connection error during unusual retry: {e}")
                session.close()
                if elevenlabs_manager.mobile_proxy:
                    elevenlabs_manager.mobile_proxy.rotate_ip()
                continue

            if response.status_code == 200:
                content = response.content
                session.close()
                
                elevenlabs_manager.update_usage(api_data['api_key'], len(text))
                proxy_manager.update_elevenlabs_request_count(proxy_obj['proxy_string'])
                
                log.info("✅ ElevenLabs unusual activity resolved after %d retries", unusual_retry + 1)
                return content, 200, {"Content-Type": "audio/mpeg"}
                
            elif response.status_code == 401:
                try:
                    error_data = response.json()
                    error_detail = error_data.get('detail', {})
                    error_status = error_detail.get('status', 'unknown')

                    if error_status == 'quota_exceeded':
                        message = error_detail.get('message', '')
                        remaining = 0
                        try:
                            match = re.search(r'You have (\d+) credits remaining', message)
                            if match:
                                remaining = int(match.group(1))
                        except Exception:
                            pass
                        elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                        log.warning("⚠️ Quota exceeded during unusual activity retry")
                        session.close()
                        return None, 402, {"error": "Quota exceeded"}

                    if error_status != 'detected_unusual_activity':
                        # Drugaya oshibka 401 - prekrashchaem popytki
                        log.error(
                            "❌ Different 401 error during unusual activity retry: %s",
                            error_status,
                        )
                        session.close()
                        return None, 401, {"error": f"API key error: {error_status}"}

                    # Vse eshche unusual activity - prodolzhaem
                    log.debug("🔄 Still unusual activity, continuing retries...")

                except json.JSONDecodeError:
                    log.error("❌ Cannot parse error during unusual activity retry")
                    session.close()
                    return None, 401, {"error": "Invalid API key"}
            else:
                try:
                    error_data = response.json()
                    detail = error_data.get('detail', {})
                    if detail.get('status') == 'quota_exceeded':
                        message = detail.get('message', '')
                        remaining = 0
                        try:
                            match = re.search(r'You have (\d+) credits remaining', message)
                            if match:
                                remaining = int(match.group(1))
                        except Exception:
                            pass
                        elevenlabs_manager.mark_quota_exceeded(api_data['api_key'], remaining, message)
                        log.warning("⚠️ Quota exceeded during unusual retry")
                        session.close()
                        return None, 402, {"error": "Quota exceeded"}
                except Exception:
                    pass
                log.warning("⚠️ Other error during unusual activity retry: %d", response.status_code)

            session.close()
            
        except Exception as e:
            log.error("❌ Error during unusual activity retry: %s", e)
            if 'session' in locals():
                session.close()
            continue
    
    log.error("❌ Max unusual activity retries exceeded")
    return None, 503, {"error": "Max unusual activity retries exceeded"}

def random_headers():
    user_agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    ]
    
    accept_languages = [
        'en-US,en;q=0.9',
        'en-GB,en;q=0.9',
        'en-US,en;q=0.9,es;q=0.8',
        'en-US,en;q=0.8,es;q=0.7',
        'en,en-US;q=0.9,en;q=0.8'
    ]
    
    return {
        'User-Agent': random.choice(user_agents),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': random.choice(accept_languages),
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    }


