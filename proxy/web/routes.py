# -*- coding: utf-8 -*-
"""
Flask web routes and API endpoints
"""
import io
import time
import json
from flask import Flask, request, make_response, send_file, jsonify
from flask_cors import CORS
import requests

import globals as g
from utils.logger import log, FULL_LOGS, maybe_truncate
from utils.logging import color_ip
from config.settings import get_openai_config
from services.openai_batcher import OpenAIRequestBatcher
from services.elevenlabs_manager import VOICE_DEFAULTS, MODEL_VOICE_PARAMS
from services.request_handlers import execute_openai_request_parallel
from chat_routes import bp as chat_bp

openai_request_batcher = OpenAIRequestBatcher()


def create_app():
    """Создает и настраивает Flask приложение"""
    app = Flask(__name__)
    CORS(app, origins="*", supports_credentials=True, allow_headers=["Content-Type", "Authorization", "X-Request-ID"])
    
    register_routes(app)
    return app

def register_routes(app):
    """Регистрирует все маршруты"""
    app.register_blueprint(chat_bp)
    @app.route("/status", methods=["get"])
    def status():
        try:
            log.info("Running")
            return jsonify({"success": True, "message": "Server is running"}), 200
        except:
            pass

    @app.route("/shutdown", methods=["POST"])
    def shutdown_server():
        """Graceful shutdown прокси сервера"""
        
        try:
            log.info("🛑 Shutdown request received")
            
            # Убираем проверку авторизации для простоты
            
            # Останавливаем активные процессы
            log.info("⏹️ Stopping active processes...")

            # Немедленно останавливаем очередь ElevenLabs
            if hasattr(g, 'elevenlabs_queue'):
                try:
                    g.elevenlabs_queue.stop()
                    log.info("🧹 ElevenLabs queue stopped")
                except Exception:
                    pass
            
            log.info("✅ Graceful shutdown initiated")
            
            # Отправляем ответ перед завершением
            response = jsonify({"success": True, "message": "Server shutdown initiated"})
            
            # Планируем завершение через 2 секунды
            import threading
            def delayed_shutdown():
                import time
                time.sleep(2)
                import os
                os._exit(0)
            
            threading.Thread(target=delayed_shutdown, daemon=True).start()
            
            return response
            
        except Exception as e:
            log.error(f"❌ Shutdown error: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route("/proxy-recraft-styles", methods=["POST", "OPTIONS"])
    def proxy_recraft_styles():
        if request.method == "OPTIONS":
            return add_cors(make_response())

        log.debug("🚀 proxy_recraft_styles() called")

        try:
            # Получаем API ключ из заголовков
            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return "Missing or invalid Authorization header", 401
            api_key = auth.replace("Bearer ", "", 1)

            # Получаем данные формы (поддержка множественных значений)
            form_data = []
            for key, values in request.form.lists():
                for value in values:
                    form_data.append((key, value))

            # Получаем файлы (поддержка нескольких файлов под одним ключом)
            files_to_send = []
            for key in request.files:
                for file in request.files.getlist(key):
                    files_to_send.append((
                        "files",
                        (file.filename, file.stream, file.content_type or "application/octet-stream")
                    ))

            log.info(f"📋 Creating Recraft style with {len(files_to_send)} files")

            # Подготавливаем заголовки для запроса к Recraft API
            headers = {
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "RecraftProxy/1.0"
            }

            # Выполняем запрос к Recraft API
            response = requests.post(
                "https://external.api.recraft.ai/v1/styles",
                headers=headers,
                data=form_data,
                files=files_to_send,
                timeout=60
            )

            # Создаем ответ
            resp = make_response(response.content, response.status_code)
            resp.headers["Content-Type"] = response.headers.get("Content-Type", "application/json")
            
            return add_cors(resp)

        except Exception as e:
            log.error(f"❌ Error in proxy_recraft_styles: {e}")
            return add_cors(make_response(f"Proxy error: {e}", 500))

    @app.route("/proxy-recraft", methods=["POST", "OPTIONS"])
    def proxy_recraft():
        """Прокси-эндпоинт для Recraft AI"""
        if request.method == "OPTIONS":
            return add_cors(make_response())
        try:
            req_json = request.get_json(silent=True) or {}
            if not req_json:
                return make_response("Missing request data", 400)

            # Получаем API ключ из заголовков
            api_key = request.headers.get("Authorization", "").replace("Bearer ", "")
            if not api_key:
                return make_response("Missing API key", 401)

            # Получаем прокси
            if g.elevenlabs_manager.mobile_proxy:
                proxy_info = g.elevenlabs_manager.mobile_proxy.get_proxy_connection_info()
                if proxy_info:
                    proxy_dict = {
                        "http": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}",
                        "https": f"http://{proxy_info['username']}:{proxy_info['password']}@{proxy_info['host']}:{proxy_info['port']}"
                    }
                    proxy_type = "mobile"
                    proxy_server = f"{proxy_info['host']}:{proxy_info['port']}"
                else:
                    return make_response("Mobile proxy connection failed", 503)
            else:
                proxy_obj = g.proxy_manager.get_available_proxy(for_elevenlabs=True)
                if not proxy_obj:
                    return make_response("No proxy available", 503)
                proxy_dict = g.elevenlabs_manager._get_proxy_dict(proxy_obj)
                proxy_type = "regular"
                proxy_server = proxy_obj.get('host', 'unknown')

            session = requests.Session()
            session.trust_env = False
            session.proxies = proxy_dict

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }

            # Тело запроса: передаем все параметры как есть, чтобы поддерживать весь функционал API
            request_body = req_json

            # Детальное логирование запроса
            log.info("📤 Recraft Request: POST https://external.api.recraft.ai/v1/images/generations")
            log.info("📤 Proxy: %s (%s)", proxy_server, proxy_type)
            headers_log = {
                k: (v if FULL_LOGS or k != 'Authorization' else f"{v[:10]}...")
                for k, v in headers.items()
            }
            log.info("📤 Headers: %s", json.dumps(headers_log, indent=2))
            log_body = dict(request_body)
            prompt = log_body.get('prompt')
            if isinstance(prompt, str):
                log_body['prompt'] = maybe_truncate(prompt, 50)
            log.info("📤 Body: %s", json.dumps(log_body, indent=2, ensure_ascii=False))
            
            request_start = time.time()
            response = session.post(
                "https://external.api.recraft.ai/v1/images/generations",
                json=request_body,
                headers=headers,
                timeout=120
            )
            request_duration = time.time() - request_start

            # Детальное логирование ответа
            log.info("📥 Recraft Response: %d (took %.2fs)", response.status_code, request_duration)
            log.info("📥 Response Headers: %s", json.dumps(dict(response.headers), indent=2))
            if response.status_code == 200:
                try:
                    response_data = response.json()
                    log.info("📥 Response Data Keys: %s", list(response_data.keys()))
                    if 'data' in response_data and response_data['data']:
                        log.info("📥 Generated %d images", len(response_data['data']))
                        for i, img in enumerate(response_data['data'][:3]):  # Логируем первые 3
                            url = img.get('url', 'No URL')
                            log.info("📥 Image %d: %s", i + 1, maybe_truncate(url, 50))
                except Exception:
                    log.info("📥 Response Size: %d bytes", len(response.content))
            else:
                log.info("📥 Response Size: %d bytes", len(response.content))

            if response.status_code == 200:
                return add_cors(make_response(response.content, 200, {
                    "Content-Type": "application/json"
                }))

            elif response.status_code == 401:
                log.error("❌ Recraft API key invalid or expired")
                return add_cors(make_response("Invalid API key", 401))

            elif response.status_code == 429:
                log.warning("⚠️ Recraft rate limit hit")
                return add_cors(make_response("Rate limit exceeded", 429))

            elif response.status_code == 400:
                try:
                    error_text = response.text
                    log.error("❌ Recraft bad request: %s", maybe_truncate(error_text, 200))
                    return add_cors(make_response(error_text, 400))
                except:
                    return add_cors(make_response("Bad request", 400))
            
            else:
                log.error("❌ Recraft API error: %d - %s", response.status_code, maybe_truncate(response.text, 200))
                return add_cors(make_response(response.text, response.status_code))

        except requests.Timeout:
            log.error("❌ Recraft request timeout (120s)")
            return add_cors(make_response("Request timeout", 504))
        
        except requests.ConnectionError as e:
            log.error("❌ Recraft connection error: %s", maybe_truncate(str(e), 100))
            return add_cors(make_response("Connection error", 503))
        
        except Exception as e:
            log.error("❌ Recraft request failed: %s", str(e))
            return add_cors(make_response(f"Request failed: {e}", 500))
        
        finally:
            try:
                session.close()
            except:
                pass


    @app.after_request
    def add_cors(resp):
        resp.headers.update({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        })
        return resp

    @app.route("/proxy-openai-images", methods=["POST", "OPTIONS"])
    def proxy_openai_images():
        if request.method == "OPTIONS":
            return add_cors(make_response())
        try:
            log.debug("🚀 proxy_openai_images() called")

            import json, base64, io, time, copy
            req_json = request.get_json(silent=True) or {}
            if not req_json:
                return make_response("Missing request data", 400)

            # сохраним модель из входа, чтобы отдать её в ответе (OpenAI Images часто не возвращает model)
            req_model = req_json.get("model") or ""

            config = get_openai_config(request.args)
            log.info("📋 OpenAI config loaded")

            # Используем глобальный лимитер из globalParams.json
            g.openai_limiter.update_config(config)
            acquired = g.openai_limiter.acquire_slot(model=req_model, tokens=0, timeout=config.get("queue_timeout"))
            if not acquired:
                retry_after = g.openai_limiter.suggest_wait_seconds(model=req_model, tokens=0)
                payload = {
                    "error": "Rate limited",
                    "retry_after_seconds": retry_after,
                    "model": req_model,
                }
                resp = make_response(json.dumps(payload), 429)
                resp.headers["Retry-After"] = str(int(retry_after)) if retry_after and retry_after != float("inf") else "2"
                resp.headers["Content-Type"] = "application/json; charset=utf-8"
                return add_cors(resp)

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return "Missing or invalid Authorization header", 401
            api_key = auth.replace("Bearer ", "", 1)

            client_ip = g.proxy_manager._get_client_ip()
            log.info("👤 Client: %s", color_ip(client_ip, is_local=True))

            # --- OpenAI Images API ---
            request_data = {
                "url": "https://api.openai.com/v1/images/generations",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "MyAppGPT/1.0",
                },
                "body": req_json,
            }
            config["use_limiter"] = False
            try:
                response_data = openai_request_batcher.enqueue(request_data, config)
            finally:
                g.openai_limiter.release_slot()

            status_code = response_data.get("status_code", 500)

            # Обрабатываем перегрузку прокси/апстрима так же, как в /proxy-responses
            if status_code in (503, 504):
                error_content = response_data.get("content", b"")
                if isinstance(error_content, bytes):
                    error_content = error_content.decode("utf-8", errors="replace")
                resp = make_response(error_content, status_code)
                retry_after = response_data.get("headers", {}).get("Retry-After", "30")
                resp.headers["Retry-After"] = retry_after
                resp.headers["Content-Type"] = "application/json; charset=utf-8"
                return add_cors(resp)

            upstream_headers = response_data.get("headers", {}) or {}
            raw_content = response_data.get("content", b"")

            # bytes -> str (для разбора JSON)
            if isinstance(raw_content, (bytes, bytearray)):
                try:
                    content_str = raw_content.decode("utf-8", errors="replace")
                except Exception:
                    content_str = None
            else:
                content_str = raw_content

            # --- Парсим JSON, usage и «оригинальное тело» для заголовка ---
            parsed = None
            usage = {}
            body_for_header_text = None  # полный body, но b64_json укорочен до 100 символов
            if content_str:
                try:
                    parsed = json.loads(content_str)
                    if isinstance(parsed, dict) and isinstance(parsed.get("usage"), dict):
                        usage = parsed["usage"] or {}

                    # клонируем и укорачиваем только b64_json
                    body_for_header = copy.deepcopy(parsed)
                    try:
                        if isinstance(body_for_header, dict):
                            # если модель не пришла от апстрима — добавим из запроса
                            if "model" not in body_for_header and req_model:
                                body_for_header["model"] = req_model
                            if isinstance(body_for_header.get("data"), list):
                                for it in body_for_header["data"]:
                                    if isinstance(it, dict) and isinstance(it.get("b64_json"), str):
                                        s = it["b64_json"]
                                        if len(s) > 100:
                                            it["b64_json"] = s[:100] + f"...(+{len(s)-100} chars)"
                    except Exception:
                        pass

                    body_for_header_text = json.dumps(body_for_header, ensure_ascii=False, separators=(",", ":"))
                    # ограничим длину хедера
                    if len(body_for_header_text) > 8000:
                        body_for_header_text = body_for_header_text[:8000] + f"...(+{len(body_for_header_text)-8000} chars)"
                except Exception as e:
                    log.warning(f"⚠️ Failed to parse JSON body: {e}")

            # Параметры выдачи
            try:
                idx = int(request.args.get("index", "0"))
            except Exception:
                idx = 0

            # filename: если прилетела шаблонка вида {{...}}, игнорируем → "image"
            filename_arg = request.args.get("filename")
            if not filename_arg or "{{" in filename_arg or "}}" in filename_arg:
                filename = "image"
            else:
                filename = filename_arg

            as_download = request.args.get("download", "0").lower() in ("1", "true", "yes")
            mode = (request.args.get("mode") or "binary").lower()  # binary | json

            # === БИНАРЬ + ОРИГИНАЛЬНОЕ ТЕЛО В ЗАГОЛОВКЕ + МОДЕЛЬ ===
            if status_code == 200 and isinstance(parsed, dict) and isinstance(parsed.get("data"), list) and parsed["data"]:
                safe_idx = max(0, min(idx, len(parsed["data"]) - 1))
                item = parsed["data"][safe_idx]
                b64 = item.get("b64_json")

                if b64 and mode == "binary":
                    try:
                        img_bytes = base64.b64decode(b64, validate=True)
                    except Exception as e:
                        log.error(f"❌ Failed to decode b64 image: {e}")
                    else:
                        resp = send_file(
                            io.BytesIO(img_bytes),
                            mimetype="image/png",
                            as_attachment=as_download,
                            download_name=filename,
                        )

                        # Пробрасываем полезные заголовки апстрима (кроме hop-by-hop и content-type)
                        excluded = {
                            "content-length", "transfer-encoding", "content-encoding",
                            "connection", "keep-alive", "upgrade",
                            "proxy-authenticate", "proxy-authorization", "te", "trailers",
                            "content-type"
                        }
                        for k, v in upstream_headers.items():
                            if k.lower() not in excluded:
                                resp.headers[k] = v

                        # usage в заголовках
                        if usage:
                            if "total_tokens" in usage:
                                resp.headers["X-OpenAI-Usage-Total-Tokens"] = str(usage["total_tokens"])
                            if "input_tokens" in usage:
                                resp.headers["X-OpenAI-Usage-Input-Tokens"] = str(usage["input_tokens"])
                            if "output_tokens" in usage:
                                resp.headers["X-OpenAI-Usage-Output-Tokens"] = str(usage["output_tokens"])
                            try:
                                usage_json = json.dumps(usage, ensure_ascii=False, separators=(",", ":"))
                                if len(usage_json) > 1000:
                                    usage_json = usage_json[:1000] + f"...(+{len(usage_json)-1000} chars)"
                                resp.headers["X-OpenAI-Usage"] = usage_json
                            except Exception:
                                pass

                        # модель в отдельном заголовке
                        if req_model:
                            resp.headers["X-OpenAI-Model"] = req_model

                        # полный body как строка в хедере (с урезанным b64_json)
                        if body_for_header_text:
                            resp.headers["X-OpenAI-Body"] = body_for_header_text

                        # Разрешаем читать кастомные заголовки
                        expose = resp.headers.get("Access-Control-Expose-Headers", "")
                        expose_set = {h.strip() for h in expose.split(",") if h.strip()}
                        expose_set.update({
                            "X-OpenAI-Body",
                            "X-OpenAI-Model",
                            "X-OpenAI-Usage",
                            "X-OpenAI-Usage-Total-Tokens",
                            "X-OpenAI-Usage-Input-Tokens",
                            "X-OpenAI-Usage-Output-Tokens",
                        })
                        resp.headers["Access-Control-Expose-Headers"] = ", ".join(sorted(expose_set))

                        resp.headers["Cache-Control"] = "no-store"
                        return add_cors(resp)

            # === ФОЛЛБЭК: JSON (укороченный body в теле, плюс модель в заголовке) ===
            if body_for_header_text:
                resp = make_response(body_for_header_text, status_code)
            else:
                resp = make_response(content_str if content_str is not None else raw_content, status_code)

            excluded = {
                "content-length", "transfer-encoding", "content-encoding",
                "connection", "keep-alive", "upgrade",
                "proxy-authenticate", "proxy-authorization", "te", "trailers"
            }
            for k, v in upstream_headers.items():
                if k.lower() not in excluded:
                    resp.headers[k] = v

            if req_model:
                resp.headers["X-OpenAI-Model"] = req_model
            resp.headers["Content-Type"] = "application/json; charset=utf-8"
            return add_cors(resp)

        except Exception as exc:
            log.error(f"❌ Proxy images error: {exc}")
            return add_cors(make_response(f"Proxy error: {exc}", 500))


# --- OpenAI-совместимый путь для генерации изображений ---
    @app.route("/v1/images/generations", methods=["POST", "OPTIONS"])
    def openai_images_generations():
        """
        Совместимость с клиентами, которые бьют в /v1/images/generations.
        Вся логика уже есть в proxy_openai_images() — просто прокидываем туда.
        """
        return proxy_openai_images()


    @app.route("/proxy-responses", methods=["POST", "OPTIONS"])
    def proxy_responses_parallel():
        if request.method == "OPTIONS":
            return add_cors(make_response())

        log.debug("🚀 proxy_responses_parallel() called")

        try:
            req_json = request.get_json(silent=True) or {}
            if not req_json:
                return "Missing request data", 400

            config = get_openai_config(request.args)

            log.info("📋 OpenAI config loaded")

            auth = request.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                return "Missing or invalid Authorization header", 401
            api_key = auth.replace("Bearer ", "", 1)

            client_ip = g.proxy_manager._get_client_ip()
            log.info("👤 Client: %s", color_ip(client_ip, is_local=True))

            request_data = {
                "url": "https://api.openai.com/v1/responses",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "MyAppGPT/1.0",
                },
                "body": req_json,
            }

            response_data = openai_request_batcher.enqueue(request_data, config)

            if response_data["status_code"] in [503, 504]:
                error_content = response_data["content"]
                if isinstance(error_content, bytes):
                    error_content = error_content.decode("utf-8")
                
                resp = make_response(error_content, response_data["status_code"])
                resp.headers["Retry-After"] = response_data["headers"].get("Retry-After", "30")
                resp.headers["Content-Type"] = "application/json; charset=utf-8"
                return add_cors(resp)

            try:
                content_str = (
                    response_data["content"].decode("utf-8")
                    if isinstance(response_data["content"], (bytes, bytearray))
                    else response_data["content"]
                )
                resp = make_response(content_str, response_data["status_code"])

                excluded = {
                    "content-length", "transfer-encoding", "content-encoding",
                    "connection", "keep-alive", "upgrade",
                    "proxy-authenticate", "proxy-authorization", "te",
                    "trailers"
                }
                for k, v in response_data["headers"].items():
                    if k.lower() not in excluded:
                        resp.headers[k] = v

                resp.headers["Content-Type"] = "application/json; charset=utf-8"
                return add_cors(resp)

            except Exception as err:
                log.error("❌ Error building response: %s", err)
                fallback = make_response(response_data["content"], response_data["status_code"])
                fallback.headers["Content-Type"] = "application/json; charset=utf-8"
                return add_cors(fallback)

        except Exception as exc:
            log.error("❌ Proxy responses error: %s", exc)
            return f"Proxy error: {exc}", 500


    # ====== УБРАННЫЙ РОУТ /clear-elevenlabs-voices (вместо него preflight в /proxy-elevenlabs) ======


    @app.route("/proxy-elevenlabs", methods=["GET"])
    def proxy_elevenlabs():
        """
        Прокси-эндпоинт для ElevenLabs TTS.
        Ставит запрос в очередь и ждёт готовый MP3 (до 10 минут).
        """

        text     = request.args.get("text")
        voice_id = request.args.get("voice_id", "EXAVITQu4vr4xnSDxMaL")
        if not text:
            return make_response("Parameter 'text' is required", 400)

        model_id = request.args.get("model_id", g.elevenlabs_manager.config.get("model_id"))
        allowed = MODEL_VOICE_PARAMS.get(model_id, VOICE_DEFAULTS.keys())

        cfg = {
            "model_id": model_id,
        }

        for param in allowed:
            raw = request.args.get(param)
            if param == "use_speaker_boost":
                cfg[param] = (raw if raw is not None else str(VOICE_DEFAULTS[param])).lower() == "true"
            else:
                cfg[param] = float(raw) if raw is not None else VOICE_DEFAULTS[param]

        log.info("📥 ElevenLabs request: text_len=%d, voice=%s", len(text), voice_id)

        # 1. Кладём задачу в очередь
        req_id = g.elevenlabs_queue.add_request(text, voice_id, cfg)

        # 2. Ждём результат (увеличиваем таймаут до 9999999 минут)
        result = g.elevenlabs_queue.wait_for_result(req_id, timeout=999999)
        if result is None:
            return make_response("Timeout waiting for TTS", 504)

        if result.get("success"):
            return add_cors(send_file(
                io.BytesIO(result["content"]),
                mimetype=result.get("content_type", "audio/mpeg"),
                as_attachment=False,
                download_name="tts.mp3"
            ))

        # Ошибка генерации
        return add_cors(make_response(result.get("error", "Generation failed"), 502))

    @app.route("/elevenlabs/refresh-quotas", methods=["POST"])
    def refresh_elevenlabs_quotas():
        try:
            data = request.get_json(silent=True) or {}
            accounts = data.get('accounts')
            if isinstance(accounts, str):
                accounts = [accounts]
            results = g.elevenlabs_manager.refresh_all_quotas(accounts=accounts)
            return jsonify({"success": True, "updated": results})
        except Exception as e:
            log.error(f"❌ Error refreshing ElevenLabs quotas: {e}")
            return jsonify({"success": False, "error": str(e)}), 500
