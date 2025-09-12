# -*- coding: utf-8 -*-
"""
Mobile proxy management
"""
import time
import threading
import requests
from utils.logger import log, FULL_LOGS, maybe_truncate

class MobileProxyManager:
    def __init__(self, proxy_id: str, api_key: str):
        self.proxy_id = proxy_id
        self.api_key = api_key
        self.base_url = "https://mobileproxy.space/api.html"
        self.changeip_url = "https://changeip.mobileproxy.space/"
        self.lock = threading.Lock()
        self.current_ip = None
        self.proxy_key = None  # Для смены IP нужен proxy_key
        self.connection_info_cache = None
        self.cache_timestamp = 0
        self.cache_ttl = 300  # 5 минут кэш
        self._last_connection_request = 0  # Защита от частых запросов
        self._rotation_in_progress = False  # Флаг активной ротации
        self._last_api_request = 0  # Rate limiting API-запросов

        # ВАЖНО: убрали ранний вызов self._initialize_proxy_key()
        # Ключ будет подтянут лениво при первой реальной необходимости (ротации/запросе).


    def _initialize_proxy_key(self):
        """Инициализирует proxy_key при создании объекта с retry логикой"""
        max_retries = 3
        retry_delay = 2
        
        for attempt in range(max_retries):
            try:
                log.debug(f"🔑 Attempting to get proxy_key, attempt {attempt + 1}/{max_retries}")
                proxy_info = self._get_proxy_info()
                if self.proxy_key:
                    log.info(f"✅ Successfully got proxy_key on attempt {attempt + 1}")
                    return
                else:
                    log.warning(f"⚠️ No proxy_key in response, attempt {attempt + 1}/{max_retries}")
                    
            except Exception as e:
                log.warning(f"⚠️ Failed to get proxy_key on attempt {attempt + 1}/{max_retries}: {e}")
                
            if attempt < max_retries - 1:
                log.debug(f"⏳ Waiting {retry_delay}s before retry...")
                time.sleep(retry_delay)
        
        log.warning("⚠️ Could not get proxy_key during initialization after all retries")
        log.info("🔄 proxy_key will be obtained on first IP rotation if needed")

    def _make_api_request(self, command: str, additional_params: dict = None):
        """Выполняет запрос к основному API с rate limiting и улучшенной обработкой ошибок"""
        # ДОБАВЛЯЕМ RATE LIMITING для API запросов
        current_time = time.time()
        time_since_last = current_time - self._last_api_request
        if time_since_last < 3:  # Минимум 3 секунды между API запросами
            wait_time = 3 - time_since_last
            log.debug(f"⏳ API rate limiting: waiting {wait_time:.1f}s")
            time.sleep(wait_time)
        
        self._last_api_request = time.time()
        
        params = {
            'command': command,
            'proxy_id': self.proxy_id
        }
        if additional_params:
            params.update(additional_params)
        
        headers = {
            'Authorization': f'Bearer {self.api_key}',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        try:
            response = requests.get(
                self.base_url, 
                params=params, 
                headers=headers, 
                timeout=30
            )
            
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                log.warning("⚠️ Mobile proxy API rate limit hit, waiting...")
                time.sleep(5)
                return None
            else:
                log.error(f"❌ API returned status {response.status_code}: {maybe_truncate(response.text, 200)}")
                return None
                
        except requests.exceptions.ConnectionError as e:
            log.warning(f"⚠️ Connection error to mobile proxy API: {e}")
            return None
        except requests.exceptions.Timeout:
            log.warning("⚠️ Timeout connecting to mobile proxy API")
            return None
        except Exception as e:
            log.error(f"❌ Mobile proxy API error: {e}")
            return None


    def _get_proxy_info(self):
        """Получает информацию о прокси включая proxy_key для смены IP"""
        result = self._make_api_request('get_my_proxy')
        if result and isinstance(result, list) and len(result) > 0:
            proxy_info = result[0]  # Берем первый прокси из списка
            # Извлекаем proxy_key из ссылки для смены IP
            change_url = proxy_info.get('proxy_change_ip_url', '')
            if 'proxy_key=' in change_url:
                self.proxy_key = change_url.split('proxy_key=')[1].split('&')[0]
                display_key = self.proxy_key if FULL_LOGS else self.proxy_key[:10] + "..."
                log.info(f"✅ Extracted proxy_key: {display_key}")
            return proxy_info
        return None
    
    def can_rotate_now(self) -> bool:
        """Проверяет можно ли сейчас ротировать IP (только отсутствие активной ротации)"""
        if self._rotation_in_progress:
            log.debug("🔄 Rotation already in progress")
            return False

        return True


    def check_rotation_status(self) -> dict:
        """Проверяет статус последней ротации IP"""
        log.debug(f"🔍 Checking rotation status...")
        try:
            start_time = time.time()
            result = self._make_api_request('proxy_ip')
            api_duration = time.time() - start_time
            
            log.debug(f"🔍 API call took {api_duration:.2f}s, result: {result}")
            
            if result and result.get('status') == 'OK':
                ip = result.get('ip')
                log.debug(f"✅ Status OK, IP: {ip}")
                return {
                    'ready': True,
                    'ip': ip,
                    'status': 'completed'
                }
            elif result and result.get('status') == 'NULL IP':
                log.debug(f"⏳ Status NULL IP - rotation still in progress")
                return {
                    'ready': False,
                    'ip': None,
                    'status': 'in_progress'
                }
            else:
                log.warning(f"⚠️ Unexpected API result: {result}")
                return {
                    'ready': False,
                    'ip': None,
                    'status': 'error',
                    'error': str(result)
                }
        except Exception as e:
            log.error(f"❌ Error checking rotation status: {e}")
            return {
                'ready': False,
                'ip': None,
                'status': 'error',
                'error': str(e)
            }


    def wait_for_rotation_complete(self, max_wait: int = 60) -> bool:
        """Ждет завершения ротации IP с проверкой статуса"""
        start_time = time.time()
        log.info(f"⏳ Starting rotation wait, max_wait={max_wait}s")
        
        attempt = 0
        while time.time() - start_time < max_wait:
            attempt += 1
            elapsed = time.time() - start_time
            log.info(f"🔍 Rotation check attempt {attempt}, elapsed: {elapsed:.1f}s/{max_wait}s")
            
            try:
                status = self.check_rotation_status()
                log.info(f"🔍 Rotation status: {status}")
                
                if status['ready']:
                    if status['ip']:
                        self.current_ip = status['ip']
                        log.info(f"✅ Rotation completed: new IP {self.current_ip} after {elapsed:.1f}s")
                        return True
                    else:
                        log.warning("⚠️ Rotation completed but no IP received, retrying...")
                        time.sleep(3)
                        continue
                elif status['status'] == 'in_progress':
                    log.info(f"⏳ Rotation in progress, waiting... (attempt {attempt}, {elapsed:.1f}s)")
                    time.sleep(5)
                else:
                    log.error(f"❌ Rotation status error: {status.get('error', 'unknown')}")
                    log.info(f"🔄 Will retry in 3 seconds...")
                    time.sleep(3)
                    
            except Exception as e:
                log.error(f"❌ Exception in rotation wait: {e}")
                time.sleep(3)
        
        final_elapsed = time.time() - start_time
        log.error(f"❌ Rotation timeout after {final_elapsed:.1f}s (max: {max_wait}s)")
        return False

    def rotate_ip(self) -> bool:
        """Ротирует IP адрес с проверкой статуса завершения"""
        log.info(f"🔄 Starting IP rotation process...")

        if not self.can_rotate_now():
            log.info("🔄 Rotation already in progress, waiting for completion...")
            return self.wait_for_rotation_complete(max_wait=60)

        with self.lock:
            
            # Устанавливаем флаг активной ротации
            self._rotation_in_progress = True
            log.info(f"🔄 Rotation flag set, starting process...")
            
            try:
                # Получаем proxy_key если его нет
                if not self.proxy_key:
                    log.info("🔍 Getting proxy_key for IP rotation...")
                    for attempt in range(3):
                        try:
                            log.info(f"🔍 Proxy key attempt {attempt + 1}/3")
                            proxy_info = self._get_proxy_info()
                            if self.proxy_key:
                                log.info(f"✅ Got proxy_key on attempt {attempt + 1}")
                                break
                            else:
                                log.warning(f"⚠️ No proxy_key in response, attempt {attempt + 1}/3")
                                if attempt < 2:
                                    time.sleep(2)
                        except Exception as e:
                            log.warning(f"⚠️ Failed to get proxy_key, attempt {attempt + 1}/3: {e}")
                            if attempt < 2:
                                time.sleep(2)
                    
                    if not self.proxy_key:
                        log.error("❌ Cannot get proxy_key for IP rotation after all retries")
                        return False
                
                log.info("🔄 Starting IP rotation request...")

                # Формируем URL для смены IP
                params = {
                    'proxy_key': self.proxy_key,
                    'format': 'json'
                }

                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }

                log.info(f"🔄 Rotation URL: {self.changeip_url}")
                log.info(f"🔄 Rotation params: {params}")

                for attempt in range(3):
                    try:
                        request_start = time.time()
                        response = requests.get(
                            self.changeip_url, params=params, headers=headers, timeout=30
                        )
                        request_duration = time.time() - request_start
                        log.info(f"🔄 Rotation request completed in {request_duration:.2f}s")

                        result = response.json()
                        log.info(f"🔍 IP rotation response: {result}")

                        if result.get('status') in ['ok', 'OK'] or result.get('code') == 200:
                            log.info("⏳ Waiting for rotation to complete...")
                            if self.wait_for_rotation_complete(max_wait=60):
                                log.info(f"✅ IP rotation successful: {self.current_ip}")
                                return True
                            log.error("❌ IP rotation timeout in wait_for_rotation_complete")
                            return False

                        if result.get('message') == 'Already change IP, please wait':
                            log.warning("⚠️ Previous rotation still in progress, waiting...")
                            if self.wait_for_rotation_complete(max_wait=60):
                                return True
                            return False

                        log.error(f"❌ IP rotation failed: {result}")
                    except requests.Timeout:
                        log.error("❌ IP rotation request timeout (30s)")
                    except Exception as e:
                        log.error(f"❌ IP rotation request failed: {e}")

                    if attempt < 2:
                        log.info("🔁 Retrying IP rotation in 5s...")
                        time.sleep(5)

                return False
                    
            finally:
                # Сбрасываем флаг активной ротации
                self._rotation_in_progress = False
                log.info(f"🔄 Rotation flag cleared")


    def get_current_ip(self) -> str:
        """Получает текущий IP адрес с rate limiting и валидацией ответа."""
        # Добавляем задержку для избежания "Too many same requests"
        time.sleep(3)

        log.info(f"🔍 Getting IP for proxy_id: {self.proxy_id}")
        result = self._make_api_request('proxy_ip')
        log.info(f"🔍 API Response: {result}")

        if result:
            if result.get('status') == 'OK' and 'ip' in result:
                ip = str(result.get('ip', '')).strip()
                # Валидация: иногда провайдер возвращает HTML (502) вместо IP
                try:
                    import ipaddress
                    if not ip or '<' in ip or '>' in ip or ip.lower().startswith('<html'):
                        raise ValueError("looks like HTML/error page")
                    ipaddress.ip_address(ip)  # проверка формата IPv4/IPv6
                except Exception:
                    log.warning("⚠️ Invalid IP in response (looks like an error page)")
                    return 'unknown'

                self.current_ip = ip
                log.info(f"✅ Got current IP: {ip}")
                return ip

            elif result.get('status') == 'NULL IP':
                log.warning("⚠️ NULL IP status, rotation in progress")
                return 'rotation_in_progress'

        log.error(f"❌ Failed to get IP. Full response: {result}")
        return 'unknown'


    def get_stats(self) -> dict:
        """Получает информацию о прокси"""
        log.info(f"🔍 Getting stats for proxy_id: {self.proxy_id}")
        result = self._make_api_request('get_my_proxy')
        
        log.info(f"🔍 Stats API Response type: {type(result)}, length: {len(result) if isinstance(result, (list, dict)) else 'N/A'}")
        
        if result:
            if isinstance(result, list) and len(result) > 0:
                log.info(f"✅ Got proxy stats")
                return result[0]  # Возвращаем информацию о первом прокси
            elif isinstance(result, dict) and result.get('status') in ['ok', 'OK']:
                log.info(f"✅ Got proxy stats (dict format)")
                return result
        
        log.error(f"❌ Failed to get stats. Response: {result}")
        return {}

    def get_proxy_connection_info(self, stats: dict = None) -> dict:
        """Получает данные для подключения к прокси серверу с кэшированием"""
        current_time = time.time()

        # Используем кэш если он еще актуален
        if (
            self.connection_info_cache
            and current_time - self.cache_timestamp < self.cache_ttl
        ):
            log.debug("✅ Using cached connection info")
            return self.connection_info_cache

        # Защита от слишком частых запросов
        if hasattr(self, "_last_connection_request"):
            if current_time - self._last_connection_request < 3:  # Минимум 3 секунды между запросами
                log.debug("⏳ Rate limiting connection info requests")
                if self.connection_info_cache:
                    return self.connection_info_cache

        self._last_connection_request = current_time

        log.info("🔍 Getting proxy connection info")

        # Если статистика не передана, запрашиваем её
        if stats is None:
            stats = self.get_stats()

        if stats:
            connection_info = {
                "host": stats.get("proxy_hostname", "or.mobileproxy.space"),
                "port": stats.get("proxy_http_port", 1049),
                "username": stats.get("proxy_login", "Ygev2e"),
                "password": stats.get("proxy_pass", "enAHepnYgAf7"),
            }
            # Сохраняем в кэш
            self.connection_info_cache = connection_info
            self.cache_timestamp = current_time
            log.info(
                f"✅ Got and cached connection info: {connection_info['host']}:{connection_info['port']}"
            )
            return connection_info

        log.error("❌ Failed to get proxy connection info")
        return None