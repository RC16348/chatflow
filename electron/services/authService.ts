/**
 * 云端授权验证服务
 * 处理机器UUID获取和云端授权验证
 *
 * 开源说明：
 * 本文件包含完整的授权验证逻辑，作为 ChatFlow 开源项目的一部分。
 * 开发者可以：
 * 1. 直接使用现有逻辑（连接到作者的授权服务器）
 * 2. 修改 AUTH_API_BASE_URL 指向自己的授权服务
 * 3. 完全移除授权验证逻辑
 *
 * 授权服务参考实现见 auth_platform/ 目录
 *
 * @license CC-BY-NC-SA-4.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';

const execAsync = promisify(exec);

// 云授权平台API地址
const AUTH_API_BASE_URL = 'http://luoka.icu';

// 缓存文件路径
let cacheDir: string;
let uuidCacheFile: string;

function initCachePaths() {
  if (!cacheDir) {
    cacheDir = join(app.getPath('userData'), 'cache');
    uuidCacheFile = join(cacheDir, 'machine_uuid.txt');
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }
}

/**
 * 授权验证结果接口
 */
export interface AuthVerifyResult {
  authorized: boolean;
  message: string;
  uuid?: string;
  license_key?: string;
  duration_type?: string;
  duration_label?: string;
  activated_at?: string;
  expires_at?: string;
  remaining_days?: number;
  contact?: string;
  expired_at?: string;
}

/**
 * 从缓存读取UUID
 */
function readUUIDFromCache(): string | null {
  try {
    initCachePaths();
    if (existsSync(uuidCacheFile)) {
      const uuid = readFileSync(uuidCacheFile, 'utf-8').trim();
      if (isValidUUID(uuid)) {
        console.log('[AuthService] 从缓存读取UUID:', uuid);
        return uuid;
      }
    }
  } catch (error) {
    console.error('[AuthService] 读取UUID缓存失败:', error);
  }
  return null;
}

/**
 * 保存UUID到缓存
 */
function saveUUIDToCache(uuid: string): void {
  try {
    initCachePaths();
    writeFileSync(uuidCacheFile, uuid, 'utf-8');
  } catch (error) {
    console.error('[AuthService] 保存UUID缓存失败:', error);
  }
}

/**
 * 获取机器UUID（Windows平台）
 * 优先从缓存读取，缓存不存在则使用注册表获取（最可靠）
 */
export async function getMachineUUID(): Promise<string> {
  console.log('[AuthService] 开始获取机器UUID...');
  const totalStartTime = Date.now();
  
  // 1. 首先尝试从缓存读取
  console.log('[AuthService] 尝试从缓存读取...');
  const cachedUUID = readUUIDFromCache();
  if (cachedUUID) {
    console.log(`[AuthService] 从缓存读取UUID成功: ${cachedUUID}, 耗时: ${Date.now() - totalStartTime}ms`);
    return cachedUUID;
  }
  console.log('[AuthService] 缓存中没有UUID');

  // 2. 优先使用注册表获取（最可靠且快速）
  try {
    console.log('[AuthService] 尝试从注册表获取UUID...');
    const startTime = Date.now();
    const uuid = await getUUIDFromRegistry();
    console.log(`[AuthService] 注册表获取耗时: ${Date.now() - startTime}ms`);
    if (uuid) {
      saveUUIDToCache(uuid);
      console.log(`[AuthService] 从注册表获取UUID成功: ${uuid}, 总耗时: ${Date.now() - totalStartTime}ms`);
      return uuid;
    }
    console.log('[AuthService] 注册表获取返回空值');
  } catch (error) {
    console.error('[AuthService] 注册表获取失败:', error);
  }

  // 3. 降级到WMIC命令获取
  try {
    console.log('[AuthService] 尝试使用WMIC获取UUID...');
    const startTime = Date.now();
    const uuid = await getUUIDWithWMIC();
    console.log(`[AuthService] WMIC获取耗时: ${Date.now() - startTime}ms`);
    if (uuid) {
      saveUUIDToCache(uuid);
      console.log(`[AuthService] 从WMIC获取UUID成功: ${uuid}, 总耗时: ${Date.now() - totalStartTime}ms`);
      return uuid;
    }
    console.log('[AuthService] WMIC获取返回空值');
  } catch (error) {
    console.error('[AuthService] WMIC获取失败:', error);
  }

  // 4. 最后尝试PowerShell
  try {
    console.log('[AuthService] 尝试使用PowerShell获取UUID...');
    const startTime = Date.now();
    const uuid = await getUUIDWithPowerShell();
    console.log(`[AuthService] PowerShell获取耗时: ${Date.now() - startTime}ms`);
    if (uuid) {
      saveUUIDToCache(uuid);
      console.log(`[AuthService] 从PowerShell获取UUID成功: ${uuid}, 总耗时: ${Date.now() - totalStartTime}ms`);
      return uuid;
    }
    console.log('[AuthService] PowerShell获取返回空值');
  } catch (error) {
    console.error('[AuthService] PowerShell获取失败:', error);
  }

  console.error(`[AuthService] 所有方法均已失败, 总耗时: ${Date.now() - totalStartTime}ms`);
  throw new Error('无法获取机器UUID，所有方法均已失败');
}

/**
 * 从Windows注册表获取UUID（最快最可靠）
 */
function getUUIDFromRegistry(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = exec(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { timeout: 1000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        
        // 解析注册表输出: MachineGuid    REG_SZ    XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
        const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
        if (match && isValidUUID(match[1])) {
          resolve(match[1].toUpperCase());
        } else {
          resolve(null);
        }
      }
    );

    // 1秒超时保护
    setTimeout(() => {
      child.kill();
      reject(new Error('注册表查询超时'));
    }, 1500);
  });
}

/**
 * 使用WMIC获取UUID（备用方案）
 */
function getUUIDWithWMIC(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = exec('wmic csproduct get uuid /value', { timeout: 2000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      
      const match = stdout.match(/UUID=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
      if (match && isValidUUID(match[1])) {
        resolve(match[1].toUpperCase());
      } else {
        resolve(null);
      }
    });

    setTimeout(() => {
      child.kill();
      reject(new Error('WMIC命令超时'));
    }, 3000);
  });
}

/**
 * 使用PowerShell获取UUID（最后备用）
 */
function getUUIDWithPowerShell(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = exec(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"',
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        
        const uuid = stdout.trim().toUpperCase();
        if (isValidUUID(uuid)) {
          resolve(uuid);
        } else {
          resolve(null);
        }
      }
    );

    setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell命令超时'));
    }, 5000);
  });
}

/**
 * 验证UUID格式
 */
function isValidUUID(uuid: string): boolean {
  // 标准GUID格式: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(uuid);
}

/**
 * 向云端验证授权
 * @param uuid 机器UUID
 * @returns 验证结果
 */
export async function verifyLicense(uuid: string): Promise<AuthVerifyResult> {
  console.log('[AuthService] 开始验证授权，UUID:', uuid);
  
  try {
    const url = `${AUTH_API_BASE_URL}/api/auth/verify?uuid=${encodeURIComponent(uuid)}`;
    console.log('[AuthService] 请求URL:', url);
    
    // 使用 Promise.race 实现更可靠的超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 5000);
    });
    
    const fetchPromise = fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });
    
    console.log('[AuthService] 发送请求...');
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    console.log('[AuthService] 收到响应:', response.status);
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status}`);
    }
    
    const result: AuthVerifyResult = await response.json();
    console.log('[AuthService] 验证结果:', result);
    return result;
  } catch (error) {
    console.error('[AuthService] 授权验证请求失败:', error);
    
    // 区分网络错误和其他错误
    if (error instanceof Error) {
      if (error.message === 'TIMEOUT') {
        return {
          authorized: false,
          message: '网络请求超时(5秒)，请检查网络连接后重试',
          uuid,
        };
      }
      if (error.name === 'AbortError') {
        return {
          authorized: false,
          message: '网络请求被取消',
          uuid,
        };
      }
      if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
        return {
          authorized: false,
          message: '无法连接到授权服务器，请检查网络连接',
          uuid,
        };
      }
    }
    
    return {
      authorized: false,
      message: `验证失败: ${error instanceof Error ? error.message : String(error)}`,
      uuid,
    };
  }
}

/**
 * 执行完整的授权验证流程
 * @returns 验证结果
 */
export async function performAuthVerify(): Promise<AuthVerifyResult> {
  console.log('[AuthService] ===== 开始授权验证流程 =====');
  try {
    // 1. 获取机器UUID（优先从缓存）
    console.log('[AuthService] 步骤1: 获取机器UUID...');
    const uuidStartTime = Date.now();
    const uuid = await getMachineUUID();
    console.log(`[AuthService] 步骤1完成: 获取UUID耗时 ${Date.now() - uuidStartTime}ms, UUID: ${uuid}`);

    // 2. 向云端验证
    console.log('[AuthService] 步骤2: 向云端验证...');
    const verifyStartTime = Date.now();
    const result = await verifyLicense(uuid);
    console.log(`[AuthService] 步骤2完成: 验证耗时 ${Date.now() - verifyStartTime}ms, 结果:`, result);

    console.log('[AuthService] ===== 授权验证流程完成 =====');
    return result;
  } catch (error) {
    console.error('[AuthService] 授权验证流程失败:', error);
    return {
      authorized: false,
      message: error instanceof Error ? error.message : '授权验证失败',
    };
  }
}

// ─── API Key 获取与缓存 ──────────────────────────────────

const API_KEY_CACHE_FILE = 'ai_api_key_cache.enc';
const API_KEY_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12小时

interface ApiKeyCache {
  api_key: string;
  api_url: string;
  model: string;
  cached_at: number;
}

/**
 * 使用 Electron safeStorage (DPAPI) 加密数据
 */
function encryptData(plainText: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plainText);
  }
  // 降级：如果 DPAPI 不可用，返回 Base64 编码（防君子不防小人）
  console.warn('[AuthService] DPAPI 不可用，降级为 Base64 编码');
  return Buffer.from(plainText, 'utf-8');
}

/**
 * 使用 Electron safeStorage (DPAPI) 解密数据
 */
function decryptData(encrypted: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(encrypted);
    } catch {
      // 解密失败，可能是不兼容的旧格式
      console.warn('[AuthService] DPAPI 解密失败，尝试 Base64 降级');
      return encrypted.toString('utf-8');
    }
  }
  return encrypted.toString('utf-8');
}

/**
 * 从本地缓存读取 API Key（加密存储）
 * 自动迁移旧的明文缓存到加密格式
 */
function readApiKeyCache(): ApiKeyCache | null {
  try {
    initCachePaths();
    const cacheFile = join(cacheDir, API_KEY_CACHE_FILE);
    const oldCacheFile = join(cacheDir, 'ai_api_key_cache.json');

    // 如果旧明文缓存存在，迁移到加密格式
    if (!existsSync(cacheFile) && existsSync(oldCacheFile)) {
      try {
        const oldContent = readFileSync(oldCacheFile, 'utf-8');
        const oldCache: ApiKeyCache = JSON.parse(oldContent);
        if (oldCache.api_key) {
          saveApiKeyCache(oldCache);
          unlinkSync(oldCacheFile);
          console.log('[AuthService] 已将旧明文缓存迁移为加密格式');
          // 迁移后检查是否过期
          if (Date.now() - oldCache.cached_at < API_KEY_CACHE_TTL_MS) {
            return oldCache;
          }
          return null;
        }
      } catch (migrateError) {
        console.error('[AuthService] 迁移旧缓存失败:', migrateError);
        // 迁移失败，删除旧文件
        try { unlinkSync(oldCacheFile) } catch (_) {}
      }
    }

    if (existsSync(cacheFile)) {
      const encrypted = readFileSync(cacheFile);
      const decrypted = decryptData(encrypted);
      const cache: ApiKeyCache = JSON.parse(decrypted);
      // 检查是否过期
      if (Date.now() - cache.cached_at < API_KEY_CACHE_TTL_MS) {
        console.log('[AuthService] API Key 缓存有效，剩余时间:', Math.round((API_KEY_CACHE_TTL_MS - (Date.now() - cache.cached_at)) / 60000), '分钟');
        return cache;
      }
      console.log('[AuthService] API Key 缓存已过期');
    }
  } catch (error) {
    console.error('[AuthService] 读取 API Key 缓存失败:', error);
  }
  return null;
}

/**
 * 保存 API Key 到本地缓存（加密存储）
 */
function saveApiKeyCache(cache: ApiKeyCache): void {
  try {
    initCachePaths();
    const cacheFile = join(cacheDir, API_KEY_CACHE_FILE);
    const plainText = JSON.stringify(cache);
    const encrypted = encryptData(plainText);
    writeFileSync(cacheFile, encrypted);
    console.log('[AuthService] API Key 已加密缓存');
  } catch (error) {
    console.error('[AuthService] 保存 API Key 缓存失败:', error);
  }
}

/**
 * 清除 API Key 缓存
 */
export function clearApiKeyCache(): void {
  try {
    initCachePaths();
    const cacheFile = join(cacheDir, API_KEY_CACHE_FILE);
    if (existsSync(cacheFile)) {
      unlinkSync(cacheFile);
      console.log('[AuthService] API Key 缓存已清除');
    }
  } catch (error) {
    console.error('[AuthService] 清除 API Key 缓存失败:', error);
  }
}

/**
 * 获取 API Key 接口返回类型
 */
export interface ApiKeyResult {
  authorized: boolean;
  has_key?: boolean;
  api_key?: string;
  api_url?: string;
  model?: string;
  message?: string;
}

/**
 * 从服务器获取 API Key（带 12 小时缓存）
 * 优先读缓存，缓存过期或不存在时向服务器请求
 */
export async function fetchApiKey(): Promise<ApiKeyResult> {
  console.log('[AuthService] ===== 获取 API Key =====');

  // 1. 尝试读取缓存
  const cached = readApiKeyCache();
  if (cached) {
    return {
      authorized: true,
      has_key: true,
      api_key: cached.api_key,
      api_url: cached.api_url,
      model: cached.model,
    };
  }

  // 2. 缓存无效，向服务器请求
  try {
    const uuid = await getMachineUUID();
    const url = `${AUTH_API_BASE_URL}/api/auth/getApiKey?uuid=${encodeURIComponent(uuid)}`;
    console.log('[AuthService] 请求 API Key:', url);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 8000);
    });

    const fetchPromise = fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status}`);
    }

    const result: ApiKeyResult = await response.json();
    console.log('[AuthService] API Key 获取结果:', { authorized: result.authorized, has_key: result.has_key });

    // 3. 如果获取成功，写入缓存
    if (result.authorized && result.has_key && result.api_key) {
      saveApiKeyCache({
        api_key: result.api_key,
        api_url: result.api_url || 'https://api.deepseek.com',
        model: result.model || '',
        cached_at: Date.now(),
      });
    }

    return result;
  } catch (error) {
    console.error('[AuthService] 获取 API Key 失败:', error);
    return {
      authorized: false,
      has_key: false,
      message: error instanceof Error ? error.message : '获取 API Key 失败',
    };
  }
}
