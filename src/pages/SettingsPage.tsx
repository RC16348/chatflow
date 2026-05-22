import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { useChatStore } from '../stores/chatStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { useAnalyticsStore } from '../stores/analyticsStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  Eye, EyeOff, FolderSearch, FolderOpen, Search, Copy,
  RotateCcw, Trash2, Plug, Check, Sun, Moon, Monitor,
  Palette, Database, HardDrive, ChevronDown, Download, Mic,
  Bell, X, Sparkles, Loader2, RefreshCw, UserRound
} from 'lucide-react'
import { Avatar } from '../components/Avatar'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'notification' | 'antiRevoke' | 'database' | 'models' | 'cache' | 'insight' | 'license'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'notification', label: '通知', icon: Bell },
  { id: 'antiRevoke', label: '防撤回', icon: RotateCcw },
  { id: 'database', label: '聊天数据库', icon: Database },
  { id: 'models', label: '语音识别', icon: Mic },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'insight', label: 'AI 见解', icon: Sparkles },
  { id: 'license', label: '授权', icon: UserRound }
]

const isMac = navigator.userAgent.toLowerCase().includes('mac')
const isLinux = navigator.userAgent.toLowerCase().includes('linux')
const isWindows = !isMac && !isLinux

const dbDirName = isMac ? '2.0b4.0.9 目录' : 'xwechat_files 目录'
const dbPathPlaceholder = isMac
    ? '例如: ~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
    : isLinux
        ? '例如: ~/.local/share/WeChat/xwechat_files 或者 ~/Documents/xwechat_files'
        : '例如: C:\\Users\\xxx\\Documents\\xwechat_files'


interface WxidOption {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

interface SettingsPageProps {
  onClose?: () => void
}

function SettingsPage({ onClose }: SettingsPageProps = {}) {
  const location = useLocation()
  const {
    isDbConnected,
    setDbConnected,
    setLoading,
    reset
  } = useAppStore()

  const chatSessions = useChatStore((state) => state.sessions)
  const setChatSessions = useChatStore((state) => state.setSessions)
  const resetChatStore = useChatStore((state) => state.reset)
  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const effectiveMode = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode
  const clearAnalyticsStoreCache = useAnalyticsStore((state) => state.clearCache)

  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<WxidOption[]>([])
  const [showWxidSelect, setShowWxidSelect] = useState(false)
  const [cachePath, setCachePath] = useState('')
  const [imageKeyProgress, setImageKeyProgress] = useState(0)
  const [imageKeyPercent, setImageKeyPercent] = useState<number | null>(null)

  const [logEnabled, setLogEnabled] = useState(false)
  const [whisperModelName, setWhisperModelName] = useState('base')
  const [whisperModelDir, setWhisperModelDir] = useState('')
  const [isWhisperDownloading, setIsWhisperDownloading] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [whisperProgressData, setWhisperProgressData] = useState<{ downloaded: number; total: number; speed: number }>({ downloaded: 0, total: 0, speed: 0 })
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; tokensPath?: string } | null>(null)

  const [autoTranscribeVoice, setAutoTranscribeVoice] = useState(false)
  const [transcribeLanguages, setTranscribeLanguages] = useState<string[]>(['zh'])

  const [notificationEnabled, setNotificationEnabled] = useState(true)
  const [notificationPosition, setNotificationPosition] = useState<'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'>('top-right')
  const [notificationFilterMode, setNotificationFilterMode] = useState<'all' | 'whitelist' | 'blacklist'>('all')
  const [notificationFilterList, setNotificationFilterList] = useState<string[]>([])
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [launchAtStartupSupported, setLaunchAtStartupSupported] = useState(isWindows || isMac)
  const [launchAtStartupReason, setLaunchAtStartupReason] = useState('')
  const [windowCloseBehavior, setWindowCloseBehavior] = useState<configService.WindowCloseBehavior>('ask')
  const [filterSearchKeyword, setFilterSearchKeyword] = useState('')
  const [filterModeDropdownOpen, setFilterModeDropdownOpen] = useState(false)
  const [positionDropdownOpen, setPositionDropdownOpen] = useState(false)
  const [closeBehaviorDropdownOpen, setCloseBehaviorDropdownOpen] = useState(false)

  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [isUpdatingLaunchAtStartup, setIsUpdatingLaunchAtStartup] = useState(false)

  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)
  const [isClearingAnalyticsCache, setIsClearingAnalyticsCache] = useState(false)
  const [isClearingImageCache, setIsClearingImageCache] = useState(false)
  const [isClearingAllCache, setIsClearingAllCache] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // 防撤回 state
  const [antiRevokeSearchKeyword, setAntiRevokeSearchKeyword] = useState('')
  const [antiRevokeSelectedIds, setAntiRevokeSelectedIds] = useState<Set<string>>(new Set())
  const [antiRevokeStatusMap, setAntiRevokeStatusMap] = useState<Record<string, { installed?: boolean; loading?: boolean; error?: string }>>({})
  const [isAntiRevokeRefreshing, setIsAntiRevokeRefreshing] = useState(false)
  const [isAntiRevokeInstalling, setIsAntiRevokeInstalling] = useState(false)
  const [isAntiRevokeUninstalling, setIsAntiRevokeUninstalling] = useState(false)
  const [antiRevokeSummary, setAntiRevokeSummary] = useState<{ action: 'refresh' | 'install' | 'uninstall'; success: number; failed: number } | null>(null)
  const [antiRevokeNotificationEnabled, setAntiRevokeNotificationEnabled] = useState(false)
  const [antiRevokeNotificationShowContent, setAntiRevokeNotificationShowContent] = useState(true)

  const isClearingCache = isClearingAnalyticsCache || isClearingImageCache || isClearingAllCache

  // AI 见解 state
  const [aiInsightEnabled, setAiInsightEnabled] = useState(false)
  const [aiInsightSilenceDays, setAiInsightSilenceDays] = useState(3)
  const [aiInsightAllowContext, setAiInsightAllowContext] = useState(false)
  const [aiInsightWhitelistEnabled, setAiInsightWhitelistEnabled] = useState(false)
  const [aiInsightWhitelist, setAiInsightWhitelist] = useState<Set<string>>(new Set())
  const [insightWhitelistSearch, setInsightWhitelistSearch] = useState('')
  const [aiInsightCooldownMinutes, setAiInsightCooldownMinutes] = useState(120)
  const [aiInsightScanIntervalHours, setAiInsightScanIntervalHours] = useState(4)
  const [aiInsightContextCount, setAiInsightContextCount] = useState(8)
  const [aiInsightTestResult, setAiInsightTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [isAiInsightTesting, setIsAiInsightTesting] = useState(false)
  const [helloAvailable, setHelloAvailable] = useState(false)

  // 授权 state
  const [licenseInfo, setLicenseInfo] = useState<{
    authorized: boolean
    message: string
    uuid?: string
    license_key?: string
    duration_type?: string
    duration_label?: string
    activated_at?: string
    expires_at?: string
    remaining_days?: number | null
    contact?: string
  } | null>(null)
  const [isLicenseLoading, setIsLicenseLoading] = useState(false)
  const [quoteLayout, setQuoteLayout] = useState('quote-top')

  // 检查 Hello 可用性
  useEffect(() => {
    setHelloAvailable(isWindows)
  }, [])

  useEffect(() => {
    loadConfig()
    // 初始加载授权信息
    void loadLicenseInfo()
    return () => {
      Object.values(saveTimersRef.current).forEach((timer) => clearTimeout(timer))
    }
  }, [])

  useEffect(() => {
    const initialTab = (location.state as { initialTab?: SettingsTab } | null)?.initialTab
    if (!initialTab) return
    setActiveTab(initialTab)
  }, [location.state])

  useEffect(() => {
    if (!onClose) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      setDbKeyStatus(payload.message)
    })

    const removeImage = window.electronAPI.key.onImageKeyStatus((payload: { message: string, percent?: number }) => {
      let msg = payload.message;
      let pct = payload.percent;

      // 如果后端没有显式传 percent，则用正则从字符串中提取如 "(12.5%)"
      if (pct === undefined) {
        const match = msg.match(/\(([\d.]+)%\)/);
        if (match) {
          pct = parseFloat(match[1]);
          // 将百分比从文本中剥离，让 UI 更清爽
          msg = msg.replace(/\s*\([\d.]+%\)/, '');
        }
      }

      setImageKeyStatus(msg);
      if (pct !== undefined) {
        setImageKeyPercent(pct);
      } else if (msg.includes('启动多核') || msg.includes('定位') || msg.includes('准备')) {
        // 预热阶段
        setImageKeyPercent(0);
      }
    })
    return () => {
      removeDb?.()
      removeImage?.()
    }
  }, [])

  // 点击外部关闭自定义下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.custom-select')) {
        setFilterModeDropdownOpen(false)
        setPositionDropdownOpen(false)
        setCloseBehaviorDropdownOpen(false)
      }
    }
    if (filterModeDropdownOpen || positionDropdownOpen || closeBehaviorDropdownOpen) {
      document.addEventListener('click', handleClickOutside)
    }
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [closeBehaviorDropdownOpen, filterModeDropdownOpen, positionDropdownOpen])


  const loadConfig = async () => {
    try {
      const savedKey = await configService.getDecryptKey()
      const savedPath = await configService.getDbPath()
      const savedWxid = await configService.getMyWxid()
      const savedCachePath = await configService.getCachePath()

      const savedLogEnabled = await configService.getLogEnabled()
      const savedImageXorKey = await configService.getImageXorKey()
      const savedImageAesKey = await configService.getImageAesKey()
      const savedWhisperModelName = await configService.getWhisperModelName()
      const savedWhisperModelDir = await configService.getWhisperModelDir()
      const savedAutoTranscribe = await configService.getAutoTranscribeVoice()
      const savedTranscribeLanguages = await configService.getTranscribeLanguages()
      const savedNotificationEnabled = await configService.getNotificationEnabled()
      const savedNotificationPosition = await configService.getNotificationPosition()
      const savedNotificationFilterMode = await configService.getNotificationFilterMode()
      const savedNotificationFilterList = await configService.getNotificationFilterList()
      const savedLaunchAtStartupStatus = await window.electronAPI.app.getLaunchAtStartupStatus()
      const savedWindowCloseBehavior = await configService.getWindowCloseBehavior()

      setLaunchAtStartup(savedLaunchAtStartupStatus.enabled)
      setLaunchAtStartupSupported(savedLaunchAtStartupStatus.supported)
      setLaunchAtStartupReason(savedLaunchAtStartupStatus.reason || '')
      setWindowCloseBehavior(savedWindowCloseBehavior)

      if (savedPath) setDbPath(savedPath)
      if (savedWxid) setWxid(savedWxid)
      if (savedCachePath) setCachePath(savedCachePath)


      const wxidConfig = savedWxid ? await configService.getWxidConfig(savedWxid) : null
      const decryptKeyToUse = wxidConfig?.decryptKey ?? savedKey ?? ''
      const imageXorKeyToUse = typeof wxidConfig?.imageXorKey === 'number'
        ? wxidConfig.imageXorKey
        : savedImageXorKey
      const imageAesKeyToUse = wxidConfig?.imageAesKey ?? savedImageAesKey ?? ''

      setDecryptKey(decryptKeyToUse)
      if (typeof imageXorKeyToUse === 'number') {
        setImageXorKey(`0x${imageXorKeyToUse.toString(16).toUpperCase().padStart(2, '0')}`)
      } else {
        setImageXorKey('')
      }
      setImageAesKey(imageAesKeyToUse)
      setLogEnabled(savedLogEnabled)
      setAutoTranscribeVoice(savedAutoTranscribe)
      setTranscribeLanguages(savedTranscribeLanguages)

      setNotificationEnabled(savedNotificationEnabled)
      setNotificationPosition(savedNotificationPosition)
      setNotificationFilterMode(savedNotificationFilterMode)
      setNotificationFilterList(savedNotificationFilterList)

      // 如果语言列表为空，保存默认值
      if (!savedTranscribeLanguages || savedTranscribeLanguages.length === 0) {
        const defaultLanguages = ['zh']
        setTranscribeLanguages(defaultLanguages)
        await configService.setTranscribeLanguages(defaultLanguages)
      }


      if (savedWhisperModelDir) setWhisperModelDir(savedWhisperModelDir)

      // 加载 AI 见解配置
      const savedAiInsightEnabled = await configService.getAiInsightEnabled()
      const savedAiInsightSilenceDays = await configService.getAiInsightSilenceDays()
      const savedAiInsightAllowContext = await configService.getAiInsightAllowContext()
      const savedAiInsightWhitelistEnabled = await configService.getAiInsightWhitelistEnabled()
      const savedAiInsightWhitelist = await configService.getAiInsightWhitelist()
      const savedAiInsightCooldownMinutes = await configService.getAiInsightCooldownMinutes()
      const savedAiInsightScanIntervalHours = await configService.getAiInsightScanIntervalHours()
      const savedAiInsightContextCount = await configService.getAiInsightContextCount()
      setAiInsightEnabled(savedAiInsightEnabled)
      setAiInsightSilenceDays(savedAiInsightSilenceDays)
      setAiInsightAllowContext(savedAiInsightAllowContext)
      setAiInsightWhitelistEnabled(savedAiInsightWhitelistEnabled)
      setAiInsightWhitelist(new Set(savedAiInsightWhitelist))
      setAiInsightCooldownMinutes(savedAiInsightCooldownMinutes)
      setAiInsightScanIntervalHours(savedAiInsightScanIntervalHours)
      setAiInsightContextCount(savedAiInsightContextCount)

      // 加载防撤回通知配置
      const savedAntiRevokeNotificationEnabled = await configService.getAntiRevokeNotificationEnabled()
      const savedAntiRevokeNotificationShowContent = await configService.getAntiRevokeNotificationShowContent()
      setAntiRevokeNotificationEnabled(savedAntiRevokeNotificationEnabled)
      setAntiRevokeNotificationShowContent(savedAntiRevokeNotificationShowContent)

      // 加载引用消息布局配置
      void configService.getQuoteLayout().then((v) => { if (v) setQuoteLayout(v) })

    } catch (e: any) {
      console.error('加载配置失败:', e)
    }
  }



  const handleLaunchAtStartupChange = async (enabled: boolean) => {
    if (isUpdatingLaunchAtStartup) return

    try {
      setIsUpdatingLaunchAtStartup(true)
      const result = await window.electronAPI.app.setLaunchAtStartup(enabled)
      setLaunchAtStartup(result.enabled)
      setLaunchAtStartupSupported(result.supported)
      setLaunchAtStartupReason(result.reason || '')

      if (result.success) {
        showMessage(enabled ? '已开启开机自启动' : '已关闭开机自启动', true)
        return
      }

      showMessage(result.error || result.reason || '设置开机自启动失败', false)
    } catch (e: any) {
      showMessage(`设置开机自启动失败: ${e?.message || String(e)}`, false)
    } finally {
      setIsUpdatingLaunchAtStartup(false)
    }
  }

  const refreshWhisperStatus = async (modelDirValue = whisperModelDir) => {
    try {
      const result = await window.electronAPI.whisper?.getModelStatus()
      if (result?.success) {
        setWhisperModelStatus({
          exists: Boolean(result.exists),
          modelPath: result.modelPath,
          tokensPath: result.tokensPath
        })
      }
    } catch {
      setWhisperModelStatus(null)
    }
  }

  useEffect(() => {
    const removeListener = window.electronAPI.whisper?.onDownloadProgress?.((payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number; speed?: number }) => {
      setWhisperProgressData({
        downloaded: payload.downloadedBytes,
        total: payload.totalBytes || 0,
        speed: payload.speed || 0
      })
      if (typeof payload.percent === 'number') {
        setWhisperDownloadProgress(payload.percent)
      }
    })
    return () => removeListener?.()
  }, [])

  useEffect(() => {
    void refreshWhisperStatus(whisperModelDir)
  }, [whisperModelDir])

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleClose = () => {
    if (!onClose) return
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 200)
  }

  const normalizeSessionIds = (sessionIds: string[]): string[] =>
    Array.from(new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)))

  const getCurrentAntiRevokeSessionIds = (): string[] =>
    normalizeSessionIds(chatSessions.map((session) => session.username))

  const ensureAntiRevokeSessionsLoaded = async (): Promise<string[]> => {
    const current = getCurrentAntiRevokeSessionIds()
    if (current.length > 0) return current
    const sessionsResult = await window.electronAPI.chat.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      throw new Error(sessionsResult.error || '加载会话失败')
    }
    setChatSessions(sessionsResult.sessions)
    return normalizeSessionIds(sessionsResult.sessions.map((session) => session.username))
  }

  const markAntiRevokeRowsLoading = (sessionIds: string[]) => {
    setAntiRevokeStatusMap((prev) => {
      const next = { ...prev }
      for (const sessionId of sessionIds) {
        next[sessionId] = {
          ...(next[sessionId] || {}),
          loading: true,
          error: undefined
        }
      }
      return next
    })
  }

  const handleRefreshAntiRevokeStatus = async (sessionIds?: string[]) => {
    if (isAntiRevokeRefreshing || isAntiRevokeInstalling || isAntiRevokeUninstalling) return
    setAntiRevokeSummary(null)
    setIsAntiRevokeRefreshing(true)
    try {
      const targetIds = normalizeSessionIds(
        sessionIds && sessionIds.length > 0
          ? sessionIds
          : await ensureAntiRevokeSessionsLoaded()
      )
      if (targetIds.length === 0) {
        setAntiRevokeStatusMap({})
        showMessage('暂无可检查的会话', true)
        return
      }
      markAntiRevokeRowsLoading(targetIds)

      const result = await window.electronAPI.chat.checkAntiRevokeTriggers(targetIds)
      if (!result.success || !result.rows) {
        const errorText = result.error || '防撤回状态检查失败'
        setAntiRevokeStatusMap((prev) => {
          const next = { ...prev }
          for (const sessionId of targetIds) {
            next[sessionId] = {
              ...(next[sessionId] || {}),
              loading: false,
              error: errorText
            }
          }
          return next
        })
        showMessage(errorText, false)
        return
      }

      const rowMap = new Map<string, { sessionId: string; success: boolean; installed?: boolean; error?: string }>()
      for (const row of result.rows || []) {
        const sessionId = String(row.sessionId || '').trim()
        if (!sessionId) continue
        rowMap.set(sessionId, row)
      }
      const mergedRows = targetIds.map((sessionId) => (
        rowMap.get(sessionId) || { sessionId, success: false, error: '状态查询未返回结果' }
      ))
      const successCount = mergedRows.filter((row) => row.success).length
      const failedCount = mergedRows.length - successCount
      setAntiRevokeStatusMap((prev) => {
        const next = { ...prev }
        for (const row of mergedRows) {
          const sessionId = String(row.sessionId || '').trim()
          if (!sessionId) continue
          next[sessionId] = {
            installed: row.installed === true,
            loading: false,
            error: row.success ? undefined : (row.error || '状态查询失败')
          }
        }
        return next
      })
      setAntiRevokeSummary({ action: 'refresh', success: successCount, failed: failedCount })
      showMessage(`状态刷新完成：成功 ${successCount}，失败 ${failedCount}`, failedCount === 0)
    } catch (e: any) {
      showMessage(`防撤回状态刷新失败: ${e?.message || String(e)}`, false)
    } finally {
      setIsAntiRevokeRefreshing(false)
    }
  }

  const handleInstallAntiRevokeTriggers = async () => {
    if (isAntiRevokeRefreshing || isAntiRevokeInstalling || isAntiRevokeUninstalling) return
    const sessionIds = normalizeSessionIds(Array.from(antiRevokeSelectedIds))
    if (sessionIds.length === 0) {
      showMessage('请先选择至少一个会话', false)
      return
    }
    setAntiRevokeSummary(null)
    setIsAntiRevokeInstalling(true)
    try {
      markAntiRevokeRowsLoading(sessionIds)
      const result = await window.electronAPI.chat.installAntiRevokeTriggers(sessionIds)
      if (!result.success || !result.rows) {
        const errorText = result.error || '批量安装失败'
        setAntiRevokeStatusMap((prev) => {
          const next = { ...prev }
          for (const sessionId of sessionIds) {
            next[sessionId] = {
              ...(next[sessionId] || {}),
              loading: false,
              error: errorText
            }
          }
          return next
        })
        showMessage(errorText, false)
        return
      }

      const rowMap = new Map<string, { sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>()
      for (const row of result.rows || []) {
        const sessionId = String(row.sessionId || '').trim()
        if (!sessionId) continue
        rowMap.set(sessionId, row)
      }
      const mergedRows = sessionIds.map((sessionId) => (
        rowMap.get(sessionId) || { sessionId, success: false, error: '安装未返回结果' }
      ))
      const successCount = mergedRows.filter((row) => row.success).length
      const failedCount = mergedRows.length - successCount
      setAntiRevokeStatusMap((prev) => {
        const next = { ...prev }
        for (const row of mergedRows) {
          const sessionId = String(row.sessionId || '').trim()
          if (!sessionId) continue
          next[sessionId] = {
            installed: row.success ? true : next[sessionId]?.installed,
            loading: false,
            error: row.success ? undefined : (row.error || '安装失败')
          }
        }
        return next
      })
      setAntiRevokeSummary({ action: 'install', success: successCount, failed: failedCount })
      showMessage(`批量安装完成：成功 ${successCount}，失败 ${failedCount}`, failedCount === 0)
    } catch (e: any) {
      showMessage(`批量安装失败: ${e?.message || String(e)}`, false)
    } finally {
      setIsAntiRevokeInstalling(false)
    }
  }

  const handleUninstallAntiRevokeTriggers = async () => {
    if (isAntiRevokeRefreshing || isAntiRevokeInstalling || isAntiRevokeUninstalling) return
    const sessionIds = normalizeSessionIds(Array.from(antiRevokeSelectedIds))
    if (sessionIds.length === 0) {
      showMessage('请先选择至少一个会话', false)
      return
    }
    setAntiRevokeSummary(null)
    setIsAntiRevokeUninstalling(true)
    try {
      markAntiRevokeRowsLoading(sessionIds)
      const result = await window.electronAPI.chat.uninstallAntiRevokeTriggers(sessionIds)
      if (!result.success || !result.rows) {
        const errorText = result.error || '批量卸载失败'
        setAntiRevokeStatusMap((prev) => {
          const next = { ...prev }
          for (const sessionId of sessionIds) {
            next[sessionId] = {
              ...(next[sessionId] || {}),
              loading: false,
              error: errorText
            }
          }
          return next
        })
        showMessage(errorText, false)
        return
      }

      const rowMap = new Map<string, { sessionId: string; success: boolean; error?: string }>()
      for (const row of result.rows || []) {
        const sessionId = String(row.sessionId || '').trim()
        if (!sessionId) continue
        rowMap.set(sessionId, row)
      }
      const mergedRows = sessionIds.map((sessionId) => (
        rowMap.get(sessionId) || { sessionId, success: false, error: '卸载未返回结果' }
      ))
      const successCount = mergedRows.filter((row) => row.success).length
      const failedCount = mergedRows.length - successCount
      setAntiRevokeStatusMap((prev) => {
        const next = { ...prev }
        for (const row of mergedRows) {
          const sessionId = String(row.sessionId || '').trim()
          if (!sessionId) continue
          next[sessionId] = {
            installed: row.success ? false : next[sessionId]?.installed,
            loading: false,
            error: row.success ? undefined : (row.error || '卸载失败')
          }
        }
        return next
      })
      setAntiRevokeSummary({ action: 'uninstall', success: successCount, failed: failedCount })
      showMessage(`批量卸载完成：成功 ${successCount}，失败 ${failedCount}`, failedCount === 0)
    } catch (e: any) {
      showMessage(`批量卸载失败: ${e?.message || String(e)}`, false)
    } finally {
      setIsAntiRevokeUninstalling(false)
    }
  }

  useEffect(() => {
    if (activeTab !== 'antiRevoke' && activeTab !== 'insight') return
    let canceled = false
    ;(async () => {
      try {
        // 两个 Tab 都需要会话列表；antiRevoke 还需要额外检查防撤回状态
        const sessionIds = await ensureAntiRevokeSessionsLoaded()
        if (canceled) return
        if (activeTab === 'antiRevoke') {
          await handleRefreshAntiRevokeStatus(sessionIds)
        }
      } catch (e: any) {
        if (!canceled) {
          showMessage(`加载会话失败: ${e?.message || String(e)}`, false)
        }
      }
    })()
    return () => {
      canceled = true
    }
  }, [activeTab])

  type WxidKeys = {
    decryptKey: string
    imageXorKey: number | null
    imageAesKey: string
  }

  const formatImageXorKey = (value: number) => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`

  const parseImageXorKey = (value: string) => {
    if (!value) return null
    const parsed = parseInt(value.replace(/^0x/i, ''), 16)
    return Number.isNaN(parsed) ? null : parsed
  }

  const buildKeysFromState = (): WxidKeys => ({
    decryptKey: decryptKey || '',
    imageXorKey: parseImageXorKey(imageXorKey),
    imageAesKey: imageAesKey || ''
  })

  const buildKeysFromInputs = (overrides?: { decryptKey?: string; imageXorKey?: string; imageAesKey?: string }): WxidKeys => ({
    decryptKey: overrides?.decryptKey ?? decryptKey ?? '',
    imageXorKey: parseImageXorKey(overrides?.imageXorKey ?? imageXorKey),
    imageAesKey: overrides?.imageAesKey ?? imageAesKey ?? ''
  })

  const buildKeysFromConfig = (wxidConfig: configService.WxidConfig | null): WxidKeys => ({
    decryptKey: wxidConfig?.decryptKey || '',
    imageXorKey: typeof wxidConfig?.imageXorKey === 'number' ? wxidConfig.imageXorKey : null,
    imageAesKey: wxidConfig?.imageAesKey || ''
  })

  const applyKeysToState = (keys: WxidKeys) => {
    setDecryptKey(keys.decryptKey)
    if (typeof keys.imageXorKey === 'number') {
      setImageXorKey(formatImageXorKey(keys.imageXorKey))
    } else {
      setImageXorKey('')
    }
    setImageAesKey(keys.imageAesKey)
  }

  const syncKeysToConfig = async (keys: WxidKeys) => {
    await configService.setDecryptKey(keys.decryptKey)
    await configService.setImageXorKey(typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0)
    await configService.setImageAesKey(keys.imageAesKey)
  }

  const applyWxidSelection = async (
    selectedWxid: string,
    options?: { preferCurrentKeys?: boolean; showToast?: boolean; toastText?: string; keysOverride?: WxidKeys }
  ) => {
    if (!selectedWxid) return

    const currentWxid = wxid
    const isSameWxid = currentWxid === selectedWxid
    if (currentWxid && currentWxid !== selectedWxid) {
      const currentKeys = buildKeysFromState()
      await configService.setWxidConfig(currentWxid, {
        decryptKey: currentKeys.decryptKey,
        imageXorKey: typeof currentKeys.imageXorKey === 'number' ? currentKeys.imageXorKey : 0,
        imageAesKey: currentKeys.imageAesKey
      })
    }

    const preferCurrentKeys = options?.preferCurrentKeys ?? false
    const keys = options?.keysOverride ?? (preferCurrentKeys
      ? buildKeysFromState()
      : buildKeysFromConfig(await configService.getWxidConfig(selectedWxid)))

    setWxid(selectedWxid)
    applyKeysToState(keys)
    await configService.setMyWxid(selectedWxid)
    await syncKeysToConfig(keys)
    await configService.setWxidConfig(selectedWxid, {
      decryptKey: keys.decryptKey,
      imageXorKey: typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0,
      imageAesKey: keys.imageAesKey
    })
    setShowWxidSelect(false)
    if (isDbConnected) {
      try {
        await window.electronAPI.chat.close()
        const result = await window.electronAPI.chat.connect()
        setDbConnected(result.success, dbPath || undefined)
        if (!result.success && result.error) {
          showMessage(result.error, false)
        }
      } catch (e: any) {
        showMessage(`切换账号后重新连接失败: ${e}`, false)
        setDbConnected(false)
      }
    }
    if (!isSameWxid) {
      clearAnalyticsStoreCache()
      resetChatStore()
      window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: selectedWxid } }))
    }
    if (options?.showToast ?? true) {
      showMessage(options?.toastText || `已选择账号：${selectedWxid}`, true)
    }
  }

  const validatePath = (path: string): string | null => {
    if (!path) return null
    // 路径验证：只检查是否为空，不再拦截中文路径
    // 中文路径支持已通过底层编码转换实现
    return null
  }

  const handleAutoDetectPath = async () => {
    if (isDetectingPath) return
    setIsDetectingPath(true)
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        const validationError = validatePath(result.path)
        if (validationError) {
          showMessage(validationError, false)
        } else {
          setDbPath(result.path)
          await configService.setDbPath(result.path)
          showMessage(`✅ 自动检测成功：已识别到微信聊天数据库根目录`, true)

          const wxids = await window.electronAPI.dbPath.scanWxids(result.path)
          setWxidOptions(wxids)
          if (wxids.length === 1) {
            await applyWxidSelection(wxids[0].wxid, {
              toastText: `已检测到账号：${wxids[0].wxid}`
            })
          } else if (wxids.length > 1) {
            setShowWxidSelect(true)
          }
        }
      } else {
        showMessage(result.error || '未能自动检测到数据库目录', false)
      }
    } catch (e: any) {
      showMessage(`自动检测失败: ${e}`, false)
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        const validationError = validatePath(selectedPath)
        if (validationError) {
          showMessage(validationError, false)
        } else {
          setDbPath(selectedPath)
          await configService.setDbPath(selectedPath)
          showMessage('已选择数据库目录', true)
        }
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }

  const handleScanWxid = async (
    silent = false,
    options?: { preferCurrentKeys?: boolean; showDialog?: boolean; keysOverride?: WxidKeys }
  ) => {
    if (!dbPath) {
      if (!silent) showMessage('请先选择数据库目录', false)
      return
    }
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      const allowDialog = options?.showDialog ?? !silent
      if (wxids.length === 1) {
        await applyWxidSelection(wxids[0].wxid, {
          preferCurrentKeys: options?.preferCurrentKeys ?? false,
          showToast: !silent,
          toastText: `已检测到账号：${wxids[0].wxid}`,
          keysOverride: options?.keysOverride
        })
      } else if (wxids.length > 1 && allowDialog) {
        setShowWxidSelect(true)
      } else {
        if (!silent) showMessage('未检测到账号目录，请检查路径', false)
      }
    } catch (e: any) {
      if (!silent) showMessage(`扫描失败: ${e}`, false)
    }
  }

  const handleSelectWxid = async (selectedWxid: string) => {
    await applyWxidSelection(selectedWxid)
  }


  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        setCachePath(selectedPath)
        await configService.setCachePath(selectedPath)
        showMessage('已选择缓存目录', true)
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }



  const handleSelectWhisperModelDir = async () => {
    try {
      const result = await dialog.openFile({ title: '选择 Whisper 模型下载目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        const dir = result.filePaths[0]
        setWhisperModelDir(dir)
        await configService.setWhisperModelDir(dir)
        showMessage('已选择 Whisper 模型目录', true)
      }
    } catch (e: any) {
      showMessage('选择目录失败', false)
    }
  }

  const handleWhisperModelChange = async (value: string) => {
    setWhisperModelName(value)
    setWhisperDownloadProgress(0)
    await configService.setWhisperModelName(value)
  }

  const handleDownloadWhisperModel = async () => {
    if (isWhisperDownloading) return
    setIsWhisperDownloading(true)
    setWhisperDownloadProgress(0)
    try {
      const result = await window.electronAPI.whisper.downloadModel()
      if (result.success) {
        setWhisperDownloadProgress(100)
        showMessage('SenseVoiceSmall 模型下载完成', true)
        await refreshWhisperStatus(whisperModelDir)
      } else {
        showMessage(result.error || '模型下载失败', false)
      }
    } catch (e: any) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsWhisperDownloading(false)
    }
  }

  const handleResetWhisperModelDir = async () => {
    setWhisperModelDir('')
    await configService.setWhisperModelDir('')
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功')
        showMessage('已自动获取解密密钥', true)
        await syncCurrentKeys({ decryptKey: result.key, wxid })
        const keysOverride = buildKeysFromInputs({ decryptKey: result.key })
        await handleScanWxid(true, { preferCurrentKeys: true, showDialog: false, keysOverride })
      } else {
        if (result.error?.includes('未找到微信安装路径') || result.error?.includes('启动微信失败')) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          showMessage(result.error || '自动获取密钥失败', false)
        }
      }
    } catch (e: any) {
      showMessage(`自动获取密钥失败: ${e}`, false)
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handleManualConfirm = async () => {
    setIsManualStartPrompt(false)
    handleAutoGetDbKey()
  }

  // Debounce config writes to avoid excessive disk IO
  const scheduleConfigSave = (key: string, task: () => Promise<void> | void, delay = 300) => {
    const timers = saveTimersRef.current
    if (timers[key]) {
      clearTimeout(timers[key])
    }
    timers[key] = setTimeout(() => {
      Promise.resolve(task()).catch((e) => {
        console.error('保存配置失败:', e)
      })
    }, delay)
  }

  const syncCurrentKeys = async (options?: { decryptKey?: string; imageXorKey?: string; imageAesKey?: string; wxid?: string }) => {
    const keys = buildKeysFromInputs(options)
    await syncKeysToConfig(keys)
    const wxidToUse = options?.wxid ?? wxid
    if (wxidToUse) {
      await configService.setWxidConfig(wxidToUse, {
        decryptKey: keys.decryptKey,
        imageXorKey: typeof keys.imageXorKey === 'number' ? keys.imageXorKey : 0,
        imageAesKey: keys.imageAesKey
      })
    }
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return;
    if (!dbPath) { showMessage('请先选择数据库目录', false); return; }
    setIsFetchingImageKey(true);
    setImageKeyPercent(0)
    setImageKeyStatus('正在初始化...');
    setImageKeyProgress(0);

    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath;
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, wxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('已获取图片密钥')
        showMessage('已自动获取图片密钥', true)
        const newXorKey = typeof result.xorKey === 'number' ? result.xorKey : 0
        const newAesKey = result.aesKey
        await configService.setImageXorKey(newXorKey)
        await configService.setImageAesKey(newAesKey)
        if (wxid) await configService.setWxidConfig(wxid, { decryptKey, imageXorKey: newXorKey, imageAesKey: newAesKey })
      } else {
        showMessage(result.error || '自动获取图片密钥失败', false)
      }
    } catch (e: any) {
      showMessage(`自动获取图片密钥失败: ${e}`, false)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const handleScanImageKeyFromMemory = async () => {
    if (isFetchingImageKey) return;
    if (!dbPath) { showMessage('请先选择数据库目录', false); return; }
    setIsFetchingImageKey(true);
    setImageKeyPercent(0)
    setImageKeyStatus('正在扫描内存...');

    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath;
      const result = await window.electronAPI.key.scanImageKeyFromMemory(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('内存扫描成功，已获取图片密钥')
        showMessage('内存扫描成功，已获取图片密钥', true)
        const newXorKey = typeof result.xorKey === 'number' ? result.xorKey : 0
        const newAesKey = result.aesKey
        await configService.setImageXorKey(newXorKey)
        await configService.setImageAesKey(newAesKey)
        if (wxid) await configService.setWxidConfig(wxid, { decryptKey, imageXorKey: newXorKey, imageAesKey: newAesKey })
      } else {
        showMessage(result.error || '内存扫描获取图片密钥失败', false)
      }
    } catch (e: any) {
      showMessage(`内存扫描失败: ${e}`, false)
    } finally {
      setIsFetchingImageKey(false)
    }
  }



  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先输入或扫描 wxid', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e: any) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  // Removed manual save config function


  const handleClearConfig = async () => {
    const confirmed = window.confirm('确定要清除当前配置吗？清除后需要重新完成首次配置？')
    if (!confirmed) return
    setIsLoadingState(true)
    setLoading(true, '正在清除配置...')
    try {
      await window.electronAPI.wcdb.close()
      await configService.clearConfig()
      reset()
      setDecryptKey('')
      setImageXorKey('')
      setImageAesKey('')
      setDbPath('')
      setWxid('')
      setCachePath('')
      setLogEnabled(false)
      setAutoTranscribeVoice(false)
      setTranscribeLanguages(['zh'])
      setWhisperModelDir('')
      setWhisperModelStatus(null)
      setWhisperDownloadProgress(0)
      setIsWhisperDownloading(false)
      setDbConnected(false)
      await window.electronAPI.window.openOnboardingWindow()
    } catch (e: any) {
      showMessage(`清除配置失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleOpenLog = async () => {
    try {
      const logPath = await window.electronAPI.log.getPath()
      await window.electronAPI.shell.openPath(logPath)
    } catch (e: any) {
      showMessage(`打开日志失败: ${e}`, false)
    }
  }

  const handleCopyLog = async () => {
    try {
      const result = await window.electronAPI.log.read()
      if (!result.success) {
        showMessage(result.error || '读取日志失败', false)
        return
      }
      await navigator.clipboard.writeText(result.content || '')
      showMessage('日志已复制到剪贴板', true)
    } catch (e: any) {
      showMessage(`复制日志失败: ${e}`, false)
    }
  }

  const handleClearLog = async () => {
    const confirmed = window.confirm('确定清空 wcdb.log 吗？')
    if (!confirmed) return
    try {
      const result = await window.electronAPI.log.clear()
      if (!result.success) {
        showMessage(result.error || '清空日志失败', false)
        return
      }
      showMessage('日志已清空', true)
    } catch (e: any) {
      showMessage(`清空日志失败: ${e}`, false)
    }
  }

  const handleClearAnalyticsCache = async () => {
    if (isClearingCache) return
    setIsClearingAnalyticsCache(true)
    try {
      const result = await window.electronAPI.cache.clearAnalytics()
      if (result.success) {
        clearAnalyticsStoreCache()
        showMessage('已清除分析缓存', true)
      } else {
        showMessage(`清除分析缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除分析缓存失败: ${e}`, false)
    } finally {
      setIsClearingAnalyticsCache(false)
    }
  }

  const handleClearImageCache = async () => {
    if (isClearingCache) return
    setIsClearingImageCache(true)
    try {
      const result = await window.electronAPI.cache.clearImages()
      if (result.success) {
        showMessage('已清除图片缓存', true)
      } else {
        showMessage(`清除图片缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除图片缓存失败: ${e}`, false)
    } finally {
      setIsClearingImageCache(false)
    }
  }

  const handleClearAllCache = async () => {
    if (isClearingCache) return
    setIsClearingAllCache(true)
    try {
      const result = await window.electronAPI.cache.clearAll()
      if (result.success) {
        clearAnalyticsStoreCache()
        showMessage('已清除所有缓存', true)
      } else {
        showMessage(`清除所有缓存失败: ${result.error || '未知错误'}`, false)
      }
    } catch (e: any) {
      showMessage(`清除所有缓存失败: ${e}`, false)
    } finally {
      setIsClearingAllCache(false)
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const renderAppearanceTab = () => (
    <div className="tab-content">
      <div className="theme-mode-toggle">
        <button className={`mode-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => setThemeMode('light')}>
          <Sun size={16} /> 浅色
        </button>
        <button className={`mode-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => setThemeMode('dark')}>
          <Moon size={16} /> 深色
        </button>
        <button className={`mode-btn ${themeMode === 'system' ? 'active' : ''}`} onClick={() => setThemeMode('system')}>
          <Monitor size={16} /> 跟随系统
        </button>
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <div key={theme.id} className={`theme-card ${currentTheme === theme.id ? 'active' : ''}`} onClick={() => setTheme(theme.id)}>
            <div className="theme-preview" style={{
              background: effectiveMode === 'dark'
                ? (theme.id === 'blossom-dream' ? 'linear-gradient(150deg, #151316 0%, #1A1620 50%, #131018 100%)'
                  : theme.id === 'geist' ? 'linear-gradient(135deg, #1a1a1a 0%, #222222 100%)'
                  : 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)')
                : (theme.id === 'blossom-dream' ? `linear-gradient(150deg, ${theme.bgColor} 0%, #F8F2F8 45%, #F2F6FB 100%)`
                  : theme.id === 'geist' ? 'linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%)'
                  : `linear-gradient(135deg, ${theme.bgColor} 0%, ${theme.bgColor}dd 100%)`)
            }}>
              <div className="theme-accent" style={{
                background: theme.accentColor
                  ? `linear-gradient(135deg, ${theme.primaryColor} 0%, ${theme.accentColor} 100%)`
                  : theme.primaryColor
              }} />
            </div>
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-desc">{theme.description}</span>
            </div>
            {currentTheme === theme.id && <div className="theme-check"><Check size={14} /></div>}
          </div>
        ))}
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>引用消息布局</label>
        <div className="quote-layout-picker">
          <button
            className={`quote-layout-card ${quoteLayout === 'quote-top' ? 'active' : ''}`}
            onClick={() => { setQuoteLayout('quote-top'); void configService.setQuoteLayout('quote-top') }}
            type="button"
          >
            <div className={`quote-layout-card-check ${quoteLayout === 'quote-top' ? 'active' : ''}`} />
            <div className="quote-layout-card-title-group">
              <span className="quote-layout-card-title">引用在上</span>
              <span className="quote-layout-card-desc">引用内容显示在消息上方</span>
            </div>
          </button>
          <button
            className={`quote-layout-card ${quoteLayout === 'quote-bottom' ? 'active' : ''}`}
            onClick={() => { setQuoteLayout('quote-bottom'); void configService.setQuoteLayout('quote-bottom') }}
            type="button"
          >
            <div className={`quote-layout-card-check ${quoteLayout === 'quote-bottom' ? 'active' : ''}`} />
            <div className="quote-layout-card-title-group">
              <span className="quote-layout-card-title">引用在下</span>
              <span className="quote-layout-card-desc">引用内容显示在消息下方</span>
            </div>
          </button>
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>开机自启动</label>
        <span className="form-hint">
          {launchAtStartupSupported
            ? '开启后，登录系统时会自动启动 ChatFlow。'
            : launchAtStartupReason || '当前环境暂不支持开机自启动。'}
        </span>
        <div className="log-toggle-line">
          <span className="log-status">
            {isUpdatingLaunchAtStartup
              ? '保存中...'
              : launchAtStartupSupported
                ? (launchAtStartup ? '已开启' : '已关闭')
                : '当前不可用'}
          </span>
          <label className="switch" htmlFor="launch-at-startup-toggle">
            <input
              id="launch-at-startup-toggle"
              className="switch-input"
              type="checkbox"
              checked={launchAtStartup}
              disabled={!launchAtStartupSupported || isUpdatingLaunchAtStartup}
              onChange={(e) => {
                void handleLaunchAtStartupChange(e.target.checked)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>关闭主窗口时</label>
        <span className="form-hint">设置点击关闭按钮后的默认行为；选择"每次询问"时会弹出关闭确认。</span>
        <div className="custom-select">
          <div
            className={`custom-select-trigger ${closeBehaviorDropdownOpen ? 'open' : ''}`}
            onClick={() => setCloseBehaviorDropdownOpen(!closeBehaviorDropdownOpen)}
          >
            <span className="custom-select-value">
              {windowCloseBehavior === 'tray'
                ? '最小化到系统托盘'
                : windowCloseBehavior === 'quit'
                  ? '完全关闭'
                  : '每次询问'}
            </span>
            <ChevronDown size={14} className={`custom-select-arrow ${closeBehaviorDropdownOpen ? 'rotate' : ''}`} />
          </div>
          <div className={`custom-select-dropdown ${closeBehaviorDropdownOpen ? 'open' : ''}`}>
            {[
              {
                value: 'ask' as const,
                label: '每次询问',
                successMessage: '已恢复关闭确认弹窗'
              },
              {
                value: 'tray' as const,
                label: '最小化到系统托盘',
                successMessage: '关闭按钮已改为最小化到托盘'
              },
              {
                value: 'quit' as const,
                label: '完全关闭',
                successMessage: '关闭按钮已改为完全关闭'
              }
            ].map(option => (
              <div
                key={option.value}
                className={`custom-select-option ${windowCloseBehavior === option.value ? 'selected' : ''}`}
                onClick={async () => {
                  setWindowCloseBehavior(option.value)
                  setCloseBehaviorDropdownOpen(false)
                  await configService.setWindowCloseBehavior(option.value)
                  showMessage(option.successMessage, true)
                }}
              >
                {option.label}
                {windowCloseBehavior === option.value && <Check size={14} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )

  const renderNotificationTab = () => {
    // 获取已过滤会话的信息
    const getSessionInfo = (username: string) => {
      const session = chatSessions.find(s => s.username === username)
      return {
        displayName: session?.displayName || username,
        avatarUrl: session?.avatarUrl || ''
      }
    }

    // 添加会话到过滤列表
    const handleAddToFilterList = async (username: string) => {
      if (notificationFilterList.includes(username)) return
      const newList = [...notificationFilterList, username]
      setNotificationFilterList(newList)
      await configService.setNotificationFilterList(newList)
      showMessage('已添加到过滤列表', true)
    }

    // 从过滤列表移除会话
    const handleRemoveFromFilterList = async (username: string) => {
      const newList = notificationFilterList.filter(u => u !== username)
      setNotificationFilterList(newList)
      await configService.setNotificationFilterList(newList)
      showMessage('已从过滤列表移除', true)
    }

    // 过滤掉已在列表中的会话，并根据搜索关键字过滤
    const availableSessions = chatSessions.filter(s => {
      if (notificationFilterList.includes(s.username)) return false
      if (filterSearchKeyword) {
        const keyword = filterSearchKeyword.toLowerCase()
        const displayName = (s.displayName || '').toLowerCase()
        const username = s.username.toLowerCase()
        return displayName.includes(keyword) || username.includes(keyword)
      }
      return true
    })

    return (
      <div className="tab-content">
        <div className="form-group">
          <label>新消息通知</label>
          <span className="form-hint">开启后，收到新消息时将显示桌面弹窗通知</span>
          <div className="log-toggle-line">
            <span className="log-status">{notificationEnabled ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="notification-enabled-toggle">
              <input
                id="notification-enabled-toggle"
                className="switch-input"
                type="checkbox"
                checked={notificationEnabled}
                onChange={async (e) => {
                  const val = e.target.checked
                  setNotificationEnabled(val)
                  await configService.setNotificationEnabled(val)
                  showMessage(val ? '已开启通知' : '已关闭通知', true)
                }}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>通知显示位置</label>
          <span className="form-hint">选择通知弹窗在屏幕上的显示位置</span>
          <div className="custom-select">
            <div
              className={`custom-select-trigger ${positionDropdownOpen ? 'open' : ''}`}
              onClick={() => setPositionDropdownOpen(!positionDropdownOpen)}
            >
              <span className="custom-select-value">
                {notificationPosition === 'top-right' ? '右上角' :
                  notificationPosition === 'bottom-right' ? '右下角' :
                    notificationPosition === 'top-left' ? '左上角' :
                      notificationPosition === 'top-center' ? '中间上方' : '左下角'}
              </span>
              <ChevronDown size={14} className={`custom-select-arrow ${positionDropdownOpen ? 'rotate' : ''}`} />
            </div>
            <div className={`custom-select-dropdown ${positionDropdownOpen ? 'open' : ''}`}>
              {[
                { value: 'top-center', label: '中间上方' },
                { value: 'top-right', label: '右上角' },
                { value: 'bottom-right', label: '右下角' },
                { value: 'top-left', label: '左上角' },
                { value: 'bottom-left', label: '左下角' }
              ].map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${notificationPosition === option.value ? 'selected' : ''}`}
                  onClick={async () => {
                    const val = option.value as 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center'
                    setNotificationPosition(val)
                    setPositionDropdownOpen(false)
                    await configService.setNotificationPosition(val)
                    showMessage('通知位置已更新', true)
                  }}
                >
                  {option.label}
                  {notificationPosition === option.value && <Check size={14} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>会话过滤</label>
          <span className="form-hint">选择只接收特定会话的通知，或屏蔽特定会话的通知</span>
          <div className="custom-select">
            <div
              className={`custom-select-trigger ${filterModeDropdownOpen ? 'open' : ''}`}
              onClick={() => setFilterModeDropdownOpen(!filterModeDropdownOpen)}
            >
              <span className="custom-select-value">
                {notificationFilterMode === 'all' ? '接收所有通知' :
                  notificationFilterMode === 'whitelist' ? '仅接收白名单' : '屏蔽黑名单'}
              </span>
              <ChevronDown size={14} className={`custom-select-arrow ${filterModeDropdownOpen ? 'rotate' : ''}`} />
            </div>
            <div className={`custom-select-dropdown ${filterModeDropdownOpen ? 'open' : ''}`}>
              {[
                { value: 'all', label: '接收所有通知' },
                { value: 'whitelist', label: '仅接收白名单' },
                { value: 'blacklist', label: '屏蔽黑名单' }
              ].map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${notificationFilterMode === option.value ? 'selected' : ''}`}
                  onClick={async () => {
                    const val = option.value as 'all' | 'whitelist' | 'blacklist'
                    setNotificationFilterMode(val)
                    setFilterModeDropdownOpen(false)
                    await configService.setNotificationFilterMode(val)
                    showMessage(
                      val === 'all' ? '已设为接收所有通知' :
                        val === 'whitelist' ? '已设为仅接收白名单通知' : '已设为屏蔽黑名单通知',
                      true
                    )
                  }}
                >
                  {option.label}
                  {notificationFilterMode === option.value && <Check size={14} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        {notificationFilterMode !== 'all' && (
          <div className="form-group">
            <label>{notificationFilterMode === 'whitelist' ? '白名单会话' : '黑名单会话'}</label>
            <span className="form-hint">
              {notificationFilterMode === 'whitelist'
                ? '点击左侧会话添加到白名单，点击右侧会话从白名单移除'
                : '点击左侧会话添加到黑名单，点击右侧会话从黑名单移除'}
            </span>

            <div className="notification-filter-container">
              {/* 可选会话列表 */}
              <div className="filter-panel">
                <div className="filter-panel-header">
                  <span>可选会话</span>
                  <div className="filter-search-box">
                    <Search size={14} />
                    <input
                      type="text"
                      placeholder="搜索会话..."
                      value={filterSearchKeyword}
                      onChange={(e) => setFilterSearchKeyword(e.target.value)}
                    />
                  </div>
                </div>
                <div className="filter-panel-list">
                  {availableSessions.length > 0 ? (
                    availableSessions.map(session => (
                      <div
                        key={session.username}
                        className="filter-panel-item"
                        onClick={() => handleAddToFilterList(session.username)}
                      >
                        <Avatar
                          src={session.avatarUrl}
                          name={session.displayName || session.username}
                          size={28}
                        />
                        <span className="filter-item-name">{session.displayName || session.username}</span>
                        <span className="filter-item-action">+</span>
                      </div>
                    ))
                  ) : (
                    <div className="filter-panel-empty">
                      {filterSearchKeyword ? '没有匹配的会话' : '暂无可添加的会话'}
                    </div>
                  )}
                </div>
              </div>

              {/* 已选会话列表 */}
              <div className="filter-panel">
                <div className="filter-panel-header">
                  <span>{notificationFilterMode === 'whitelist' ? '白名单' : '黑名单'}</span>
                  {notificationFilterList.length > 0 && (
                    <span className="filter-panel-count">{notificationFilterList.length}</span>
                  )}
                </div>
                <div className="filter-panel-list">
                  {notificationFilterList.length > 0 ? (
                    notificationFilterList.map(username => {
                      const info = getSessionInfo(username)
                      return (
                        <div
                          key={username}
                          className="filter-panel-item selected"
                          onClick={() => handleRemoveFromFilterList(username)}
                        >
                          <Avatar
                            src={info.avatarUrl}
                            name={info.displayName}
                            size={28}
                          />
                          <span className="filter-item-name">{info.displayName}</span>
                          <span className="filter-item-action">×</span>
                        </div>
                      )
                    })
                  ) : (
                    <div className="filter-panel-empty">尚未添加任何会话</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderAntiRevokeTab = () => {
    const sortedSessions = [...chatSessions].sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))
    const keyword = antiRevokeSearchKeyword.trim().toLowerCase()
    const filteredSessions = sortedSessions.filter((session) => {
      if (!keyword) return true
      const displayName = String(session.displayName || '').toLowerCase()
      const username = String(session.username || '').toLowerCase()
      return displayName.includes(keyword) || username.includes(keyword)
    })
    const filteredSessionIds = filteredSessions.map((session) => session.username)
    const selectedCount = antiRevokeSelectedIds.size
    const selectedInFilteredCount = filteredSessionIds.filter((sessionId) => antiRevokeSelectedIds.has(sessionId)).length
    const allFilteredSelected = filteredSessionIds.length > 0 && selectedInFilteredCount === filteredSessionIds.length
    const busy = isAntiRevokeRefreshing || isAntiRevokeInstalling || isAntiRevokeUninstalling
    const statusStats = filteredSessions.reduce(
      (acc, session) => {
        const rowState = antiRevokeStatusMap[session.username]
        if (rowState?.error) acc.failed += 1
        else if (rowState?.installed === true) acc.installed += 1
        else if (rowState?.installed === false) acc.notInstalled += 1
        return acc
      },
      { installed: 0, notInstalled: 0, failed: 0 }
    )

    const toggleSelected = (sessionId: string) => {
      setAntiRevokeSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        return next
      })
    }

    const selectAllFiltered = () => {
      if (filteredSessionIds.length === 0) return
      setAntiRevokeSelectedIds((prev) => {
        const next = new Set(prev)
        for (const sessionId of filteredSessionIds) {
          next.add(sessionId)
        }
        return next
      })
    }

    const clearSelection = () => {
      setAntiRevokeSelectedIds(new Set())
    }

    const handleAntiRevokeNotificationChange = async (enabled: boolean) => {
      setAntiRevokeNotificationEnabled(enabled)
      await configService.setAntiRevokeNotificationEnabled(enabled)
    }

    const handleAntiRevokeNotificationShowContentChange = async (show: boolean) => {
      setAntiRevokeNotificationShowContent(show)
      await configService.setAntiRevokeNotificationShowContent(show)
    }

    return (
      <div className="tab-content anti-revoke-tab">
        <div className="form-group">
          <label>防撤回通知</label>
          <span className="form-hint">开启后，当有人撤回消息时将显示桌面弹窗通知</span>
          <div className="log-toggle-line">
            <span className="log-status">{antiRevokeNotificationEnabled ? '已开启' : '已关闭'}</span>
            <label className="switch" htmlFor="anti-revoke-notification-toggle">
              <input
                id="anti-revoke-notification-toggle"
                className="switch-input"
                type="checkbox"
                checked={antiRevokeNotificationEnabled}
                onChange={(e) => void handleAntiRevokeNotificationChange(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        {antiRevokeNotificationEnabled && (
          <div className="form-group anti-revoke-notification-suboption">
            <label style={{ fontSize: '13px', fontWeight: 'normal' }}>在通知中显示被撤回的消息内容</label>
            <div className="log-toggle-line">
              <span className="log-status">{antiRevokeNotificationShowContent ? '显示内容' : '隐藏内容'}</span>
              <label className="switch" htmlFor="anti-revoke-notification-content-toggle">
                <input
                  id="anti-revoke-notification-content-toggle"
                  className="switch-input"
                  type="checkbox"
                  checked={antiRevokeNotificationShowContent}
                  onChange={(e) => void handleAntiRevokeNotificationShowContentChange(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
          </div>
        )}

        {/* 防撤回通知测试 */}
        {antiRevokeNotificationEnabled && (
          <div className="form-group">
            <label style={{ fontSize: '13px', fontWeight: 'normal' }}>通知测试</label>
            <span className="form-hint" style={{ fontSize: '12px' }}>
              点击"测试通知"按钮，验证防撤回通知功能是否正常。测试会模拟一条撤回消息的通知弹窗。
            </span>
            <div className="log-toggle-line" style={{ marginTop: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await window.electronAPI.chat.testAntiRevokeNotification()
                    showMessage('测试通知已发送，请查看右上角弹窗', true)
                  } catch (e: any) {
                    showMessage(`测试失败：${e?.message || '未知错误'}`, false)
                  }
                }}
              >
                测试通知
              </button>
            </div>
          </div>
        )}

        <div className="anti-revoke-hero">
          <div className="anti-revoke-hero-main">
            <h3>防撤回</h3>
          </div>
          <div className="anti-revoke-metrics">
            <div className="anti-revoke-metric is-total">
              <span className="label">筛选会话</span>
              <span className="value">{filteredSessionIds.length}</span>
            </div>
            <div className="anti-revoke-metric is-installed">
              <span className="label">已安装</span>
              <span className="value">{statusStats.installed}</span>
            </div>
            <div className="anti-revoke-metric is-pending">
              <span className="label">未安装</span>
              <span className="value">{statusStats.notInstalled}</span>
            </div>
            <div className="anti-revoke-metric is-error">
              <span className="label">异常</span>
              <span className="value">{statusStats.failed}</span>
            </div>
          </div>
        </div>

        {/* 使用说明 */}
        <div className="anti-revoke-guide">
          <div className="guide-step">
            <span className="guide-number">1</span>
            <span className="guide-text">选择会话</span>
          </div>
          <div className="guide-arrow">→</div>
          <div className="guide-step">
            <span className="guide-number">2</span>
            <span className="guide-text">安装插件</span>
          </div>
        </div>

        <div className="anti-revoke-control-card">
          <div className="anti-revoke-toolbar">
            <div className="filter-search-box anti-revoke-search">
              <Search size={14} />
              <input
                type="text"
                placeholder="搜索会话..."
                value={antiRevokeSearchKeyword}
                onChange={(e) => setAntiRevokeSearchKeyword(e.target.value)}
              />
            </div>
            <div className="anti-revoke-toolbar-actions">
              <div className="anti-revoke-btn-group">
                <button className="btn btn-secondary btn-sm" onClick={() => void handleRefreshAntiRevokeStatus()} disabled={busy}>
                  <RefreshCw size={14} /> {isAntiRevokeRefreshing ? '刷新中...' : '刷新状态'}
                </button>
              </div>
              <div className="anti-revoke-btn-group">
                <button className="btn btn-secondary btn-sm" onClick={selectAllFiltered} disabled={busy || filteredSessionIds.length === 0 || allFilteredSelected}>
                  全选
                </button>
                <button className="btn btn-secondary btn-sm" onClick={clearSelection} disabled={busy || selectedCount === 0}>
                  清空选择
                </button>
              </div>
            </div>
          </div>

          <div className="anti-revoke-batch-actions">
            <div className="anti-revoke-btn-group anti-revoke-batch-btns">
              <button className="btn btn-primary btn-sm" onClick={() => void handleInstallAntiRevokeTriggers()} disabled={busy || selectedCount === 0}>
                {isAntiRevokeInstalling ? '安装中...' : '批量安装'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => void handleUninstallAntiRevokeTriggers()} disabled={busy || selectedCount === 0}>
                {isAntiRevokeUninstalling ? '卸载中...' : '批量卸载'}
              </button>
            </div>
            <div className="anti-revoke-selected-count">
              <span>已选 <strong>{selectedCount}</strong> 个会话</span>
              <span>筛选命中 <strong>{selectedInFilteredCount}</strong> / {filteredSessionIds.length}</span>
            </div>
          </div>
        </div>

        {antiRevokeSummary && (
          <div className={`anti-revoke-summary ${antiRevokeSummary.failed > 0 ? 'error' : 'success'}`}>
            {antiRevokeSummary.action === 'refresh' ? '刷新' : antiRevokeSummary.action === 'install' ? '安装' : '卸载'}
            完成：成功 {antiRevokeSummary.success}，失败 {antiRevokeSummary.failed}
          </div>
        )}

        <div className="anti-revoke-list">
          {filteredSessions.length === 0 ? (
            <div className="anti-revoke-empty">{antiRevokeSearchKeyword ? '没有匹配的会话' : '暂无会话可配置'}</div>
          ) : (
            <>
              <div className="anti-revoke-list-header">
                <span>会话（{filteredSessions.length}）</span>
                <span>状态</span>
              </div>
              {filteredSessions.map((session) => {
                const rowState = antiRevokeStatusMap[session.username]
                let statusClass = 'unknown'
                let statusLabel = '未检查'
                if (rowState?.loading) {
                  statusClass = 'checking'
                  statusLabel = '检查中'
                } else if (rowState?.error) {
                  statusClass = 'error'
                  statusLabel = '失败'
                } else if (rowState?.installed === true) {
                  statusClass = 'installed'
                  statusLabel = '已安装'
                } else if (rowState?.installed === false) {
                  statusClass = 'not-installed'
                  statusLabel = '未安装'
                }
                return (
                  <div key={session.username} className={`anti-revoke-row ${antiRevokeSelectedIds.has(session.username) ? 'selected' : ''}`}>
                    <label className="anti-revoke-row-main">
                      <span className="anti-revoke-check">
                        <input
                          type="checkbox"
                          checked={antiRevokeSelectedIds.has(session.username)}
                          onChange={() => toggleSelected(session.username)}
                          disabled={busy}
                        />
                        <span className="check-indicator" aria-hidden="true">
                          <Check size={12} />
                        </span>
                      </span>
                      <Avatar
                        src={session.avatarUrl}
                        name={session.displayName || session.username}
                        size={30}
                      />
                      <div className="anti-revoke-row-text">
                        <span className="name">{session.displayName || session.username}</span>
                      </div>
                    </label>
                    <div className="anti-revoke-row-status">
                      <span className={`status-badge ${statusClass}`}>
                        <i className="status-dot" aria-hidden="true" />
                        {statusLabel}
                      </span>
                      {rowState?.error && <span className="status-error">{rowState.error}</span>}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    )
  }

  const renderDatabaseTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>连接测试</label>
        <span className="form-hint">检测当前数据库配置是否可用</span>
        <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isLoading || isTesting}>
          <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
        </button>
      </div>

      <div className="divider" />

      <div className="form-group">
        <label>解密密钥</label>
        <span className="form-hint">64位十六进制密钥</span>
        <div className="input-with-toggle">
          <input
            type={showDecryptKey ? 'text' : 'password'}
            placeholder="例如: a1b2c3d4e5f6..."
            value={decryptKey}
            onChange={(e) => {
              const value = e.target.value
              setDecryptKey(value)
              if (value && value.length === 64) {
                scheduleConfigSave('keys', () => syncCurrentKeys({ decryptKey: value, wxid }))
                // showMessage('解密密钥已保存', true)
              }
            }}
          />
          <button type="button" className="toggle-visibility" onClick={() => setShowDecryptKey(!showDecryptKey)}>
            {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {isManualStartPrompt ? (
          <div className="manual-prompt">
            <p className="prompt-text">未能自动启动微信，请手动启动并登录后点击下方确认</p>
            <button className="btn btn-primary btn-sm" onClick={handleManualConfirm}>
              我已启动微信，继续检测
            </button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
            <Plug size={14} /> {isFetchingDbKey ? '获取中...' : '自动获取密钥'}
          </button>
        )}
        {dbKeyStatus && <div className="form-hint status-text">{dbKeyStatus}</div>}
      </div>

      <div className="form-group">
        <label>数据库根目录</label>
        <span className="form-hint">xwechat_files 目录</span>
        <input
          type="text"
          placeholder={dbPathPlaceholder}
          value={dbPath}
          onChange={(e) => {
            const value = e.target.value
            setDbPath(value)
            scheduleConfigSave('dbPath', async () => {
              if (value) {
                await configService.setDbPath(value)
              }
            })
          }}
        />
        <div className="btn-row">
          <button className="btn btn-primary" onClick={handleAutoDetectPath} disabled={isDetectingPath}>
            <FolderSearch size={16} /> {isDetectingPath ? '检测中...' : '自动检测'}
          </button>
          <button className="btn btn-secondary" onClick={handleSelectDbPath}><FolderOpen size={16} /> 浏览选择</button>
        </div>
      </div>



      <div className="form-group">
        <label>账号 wxid</label>
        <span className="form-hint">微信账号标识</span>
        <div className="wxid-input-wrapper">
          <input
            type="text"
            placeholder="例如: wxid_xxxxxx"
            value={wxid}
            onChange={(e) => {
              const value = e.target.value
              const previousWxid = wxid
              setWxid(value)
              scheduleConfigSave('wxid', async () => {
                if (previousWxid && previousWxid !== value) {
                  const currentKeys = buildKeysFromState()
                  await configService.setWxidConfig(previousWxid, {
                    decryptKey: currentKeys.decryptKey,
                    imageXorKey: typeof currentKeys.imageXorKey === 'number' ? currentKeys.imageXorKey : 0,
                    imageAesKey: currentKeys.imageAesKey
                  })
                }
                if (value) {
                  await configService.setMyWxid(value)
                  await syncCurrentKeys({ wxid: value }) // Sync keys to the new wxid entry
                }

                if (value && previousWxid !== value) {
                  if (isDbConnected) {
                    try {
                      await window.electronAPI.chat.close()
                      const result = await window.electronAPI.chat.connect()
                      setDbConnected(result.success, dbPath || undefined)
                      if (!result.success && result.error) {
                        showMessage(result.error, false)
                      }
                    } catch (e: any) {
                      showMessage(`切换账号后重新连接失败: ${e}`, false)
                      setDbConnected(false)
                    }
                  }
                  clearAnalyticsStoreCache()
                  resetChatStore()
                  window.dispatchEvent(new CustomEvent('wxid-changed', { detail: { wxid: value } }))
                }
              })
            }}
          />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => handleScanWxid()}><Search size={14} /> 扫描 wxid</button>
      </div>

      <div className="form-group">
        <label>图片 XOR 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">用于解密图片缓存</span>
        <input
          type="text"
          placeholder="例如: 0xA4"
          value={imageXorKey}
          onChange={(e) => {
            const value = e.target.value
            setImageXorKey(value)
            const parsed = parseImageXorKey(value)
            if (value === '' || parsed !== null) {
              scheduleConfigSave('keys', () => syncCurrentKeys({ imageXorKey: value, wxid }))
            }
          }}
        />
      </div>

      <div className="form-group">
        <label>图片 AES 密钥 <span className="optional">(可选)</span></label>
        <span className="form-hint">16 位密钥</span>
        <input
          type="text"
          placeholder="16 位 AES 密钥"
          value={imageAesKey}
          onChange={(e) => {
            const value = e.target.value
            setImageAesKey(value)
            scheduleConfigSave('keys', () => syncCurrentKeys({ imageAesKey: value, wxid }))
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button className="btn btn-primary btn-sm" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey} title="从本地缓存快速计算">
            <Plug size={14} /> {isFetchingImageKey ? '获取中...' : '缓存计算（推荐）'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleScanImageKeyFromMemory} disabled={isFetchingImageKey} title="扫描微信进程内存">
            {isFetchingImageKey ? '扫描中...' : '内存扫描'}
          </button>
        </div>
        {isFetchingImageKey ? (
          <div className="brute-force-progress">
            <div className="status-header">
              <span className="status-text">{imageKeyStatus || '正在启动...'}</span>
            </div>
          </div>
        ) : (
          imageKeyStatus && <div className="form-hint status-text" style={{ marginTop: '8px' }}>{imageKeyStatus}</div>
        )}
        <span className="form-hint">优先推荐缓存计算方案。若图片无法解密，可使用内存扫描（需微信运行并打开 2-3 张图片大图）</span>
      </div>

      <div className="form-group">
        <label>调试日志</label>
        <span className="form-hint">开启后写入 WCDB 调试日志，便于排查连接问题</span>
        <div className="log-toggle-line">
          <span className="log-status">{logEnabled ? '已开启' : '已关闭'}</span>
          <label className="switch" htmlFor="log-enabled-toggle">
            <input
              id="log-enabled-toggle"
              className="switch-input"
              type="checkbox"
              checked={logEnabled}
              onChange={async (e) => {
                const enabled = e.target.checked
                setLogEnabled(enabled)
                await configService.setLogEnabled(enabled)
                showMessage(enabled ? '已开启日志' : '已关闭日志', true)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="log-actions">
          <button className="btn btn-secondary" onClick={handleOpenLog}>
            <FolderOpen size={16} /> 打开日志文件
          </button>
          <button className="btn btn-secondary" onClick={handleCopyLog}>
            <Copy size={16} /> 复制日志内容
          </button>
          <button className="btn btn-secondary" onClick={handleClearLog}>
            <Trash2 size={16} /> 清空日志
          </button>
        </div>
      </div>
    </div>
  )
  const resolvedWhisperModelPath = whisperModelDir || whisperModelStatus?.modelPath || ''

  const renderModelsTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>模型管理</label>
        <span className="form-hint">管理语音识别模型</span>
      </div>

      <div className="form-group">
        <label>语音识别模型 (Whisper)</label>
        <span className="form-hint">用于语音消息转文字功能</span>

        <div className="setting-control vertical has-border">
          <div className="model-status-card">
            <div className="model-info">
              <div className="model-name-row">
                <div className="model-name">SenseVoiceSmall</div>
                <span className="model-size">245 MB</span>
              </div>
              <div className="model-meta">
                {whisperModelStatus?.exists ? (
                  <span className="status-indicator success"><Check size={14} /> 已安装</span>
                ) : (
                  <span className="status-indicator warning">未安装</span>
                )}
                {resolvedWhisperModelPath && (
                  <div className="model-path-block">
                    <span className="path-label">模型目录</span>
                    <div className="path-text" title={resolvedWhisperModelPath}>{resolvedWhisperModelPath}</div>
                  </div>
                )}
              </div>
            </div>
            {(!whisperModelStatus?.exists || isWhisperDownloading) && (
              <div className="model-actions">
                {!whisperModelStatus?.exists && !isWhisperDownloading && (
                  <button
                    className="btn-download"
                    onClick={handleDownloadWhisperModel}
                  >
                    <Download size={16} /> 下载模型
                  </button>
                )}
                {isWhisperDownloading && (
                  <div className="download-status">
                    <div className="status-header">
                      <span className="percent">{Math.round(whisperDownloadProgress)}%</span>
                      {whisperProgressData.total > 0 && (
                        <span className="details">
                          {formatBytes(whisperProgressData.downloaded)} / {formatBytes(whisperProgressData.total)}
                          <span className="speed">({formatBytes(whisperProgressData.speed)}/s)</span>
                        </span>
                      )}
                    </div>
                    <div className="progress-bar-mini">
                      <div className="fill" style={{ width: `${whisperDownloadProgress}%` }}></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sub-setting">
            <div className="sub-label">自定义模型目录</div>
            <div className="path-selector">
              <input
                type="text"
                value={whisperModelDir}
                readOnly
                placeholder="默认目录"
              />
              <button className="btn-icon" onClick={handleSelectWhisperModelDir} title="选择目录">
                <FolderOpen size={18} />
              </button>
              {whisperModelDir && (
                <button className="btn-icon danger" onClick={handleResetWhisperModelDir} title="重置为默认">
                  <RotateCcw size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="form-group">
        <label>自动转文字</label>
        <span className="form-hint">收到语音消息时自动转换为文字</span>
        <div className="log-toggle-line">
          <span className="log-status">{autoTranscribeVoice ? '已开启' : '已关闭'}</span>
          <label className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={autoTranscribeVoice}
              onChange={(e) => {
                setAutoTranscribeVoice(e.target.checked)
                configService.setAutoTranscribeVoice(e.target.checked)
              }}
            />
            <span className="switch-slider"></span>
          </label>
        </div>
      </div>
    </div>
  )

  const renderCacheTab = () => (
      <div className="tab-content">
        <p className="section-desc">管理应用缓存数据</p>
        <div className="form-group">
          <label>缓存目录 <span className="optional">(可选)</span></label>
          <span className="form-hint">留空使用默认目录</span>
          <input
              type="text"
              placeholder="留空使用默认目录"
              value={cachePath}
              onChange={(e) => {
                const value = e.target.value
                setCachePath(value)
                scheduleConfigSave('cachePath', () => configService.setCachePath(value))
              }}
          />

          <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            当前缓存位置：
            <code style={{
              background: 'var(--bg-secondary)',
              padding: '3px 6px',
              borderRadius: '4px',
              userSelect: 'all',
              wordBreak: 'break-all',
              marginLeft: '4px'
            }}>
              {cachePath || (isMac ? '~/Documents/ChatFlow' : isLinux ? '~/Documents/ChatFlow' : '系统 文档\\ChatFlow 目录')}
            </code>
          </div>

          <div className="btn-row" style={{ marginTop: '12px' }}>
            <button className="btn btn-secondary" onClick={handleSelectCachePath}><FolderOpen size={16} /> 浏览选择</button>
            <button
                className="btn btn-secondary"
                onClick={async () => {
                  setCachePath('')
                  await configService.setCachePath('')
                }}
            >
              <RotateCcw size={16} /> 恢复默认
            </button>
          </div>
        </div>

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={handleClearAnalyticsCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除分析缓存
        </button>
        <button className="btn btn-secondary" onClick={handleClearImageCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除图片缓存
        </button>
        <button className="btn btn-danger" onClick={handleClearAllCache} disabled={isClearingCache}>
          <Trash2 size={16} /> 清除所有缓存</button>
      </div>
      <div className="divider" />
      <p className="section-desc">清除当前配置并重新开始首次引导</p>
      <div className="btn-row">
        <button className="btn btn-danger" onClick={handleClearConfig}>
          <RefreshCw size={16} /> 清除当前配置
        </button>
      </div>
    </div>
  )

  // 加载授权信息
  const loadLicenseInfo = async () => {
    setIsLicenseLoading(true)
    try {
      const result = await window.electronAPI.licenseAuth.verify()
      setLicenseInfo(result)
    } catch (error) {
      console.error('加载授权信息失败:', error)
      setLicenseInfo({
        authorized: false,
        message: '加载授权信息失败',
        contact: 'luoka328'
      })
    } finally {
      setIsLicenseLoading(false)
    }
  }

  // 复制到剪贴板
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await window.electronAPI.licenseAuth.copyToClipboard(text)
      showMessage(`${label}已复制到剪贴板`, true)
    } catch (error) {
      showMessage(`复制失败: ${error}`, false)
    }
  }

  const renderLicenseTab = () => (
    <div className="tab-content">
      <div className="form-group">
        <label>授权信息</label>
        <span className="form-hint">
          查看您的机器码和授权状态。如需获取或续期授权，请联系作者（洛卡）微信：luoka328。
        </span>
      </div>

      <div className="divider" />

      {/* 机器码 */}
      <div className="form-group">
        <label>机器码</label>
        <span className="form-hint">这是您的设备唯一标识，用于生成授权码</span>
        <div className="license-info-row">
          <div className="license-info-value">
            {isLicenseLoading ? (
              <span className="loading-text">加载中...</span>
            ) : (
              licenseInfo?.uuid || '未知'
            )}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => licenseInfo?.uuid && copyToClipboard(licenseInfo.uuid, '机器码')}
            disabled={!licenseInfo?.uuid || isLicenseLoading}
          >
            <Copy size={14} /> 复制
          </button>
        </div>
      </div>

      <div className="divider" />

      {/* 授权码 */}
      <div className="form-group">
        <label>授权码</label>
        <span className="form-hint">您的授权码，格式为 LK-XXXX-XXXX-XXXX-XXXX-XXXX</span>
        <div className="license-info-row">
          <div className={`license-info-value ${licenseInfo?.license_key ? 'has-key' : 'no-key'}`}>
            {isLicenseLoading ? (
              <span className="loading-text">加载中...</span>
            ) : licenseInfo?.license_key ? (
              licenseInfo.license_key
            ) : (
              '未获取授权'
            )}
          </div>
          {licenseInfo?.license_key && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => copyToClipboard(licenseInfo.license_key!, '授权码')}
              disabled={isLicenseLoading}
            >
              <Copy size={14} /> 复制
            </button>
          )}
        </div>
      </div>

      <div className="divider" />

      {/* 授权状态 */}
      <div className="form-group">
        <label>授权状态</label>
        <div className={`license-status ${licenseInfo?.authorized ? 'active' : 'inactive'}`}>
          {isLicenseLoading ? (
            <span className="loading-text">验证中...</span>
          ) : (
            <>
              <span className="status-icon">{licenseInfo?.authorized ? '✓' : '✗'}</span>
              <span className="status-text">
                {licenseInfo?.authorized ? '授权有效' : (licenseInfo?.license_key ? '授权已过期' : '未授权')}
              </span>
            </>
          )}
        </div>
        {!licenseInfo?.authorized && licenseInfo?.message && (
          <div className="license-message">{licenseInfo.message}</div>
        )}
      </div>

      {/* 时间信息 */}
      {licenseInfo?.authorized && (
        <>
          <div className="divider" />
          <div className="form-group">
            <label>授权详情</label>
            <div className="license-details">
              {licenseInfo.activated_at && (
                <div className="license-detail-item">
                  <span className="detail-label">激活时间：</span>
                  <span className="detail-value">{licenseInfo.activated_at}</span>
                </div>
              )}
              {licenseInfo.expires_at && (
                <div className="license-detail-item">
                  <span className="detail-label">到期时间：</span>
                  <span className="detail-value">{licenseInfo.expires_at}</span>
                </div>
              )}
              {licenseInfo.duration_label && (
                <div className="license-detail-item">
                  <span className="detail-label">授权类型：</span>
                  <span className="detail-value">{licenseInfo.duration_label}</span>
                </div>
              )}
              {licenseInfo.remaining_days !== undefined && licenseInfo.remaining_days !== null && (
                <div className="license-detail-item">
                  <span className="detail-label">剩余天数：</span>
                  <span className={`detail-value ${licenseInfo.remaining_days <= 7 ? 'warning' : ''}`}>
                    {licenseInfo.remaining_days} 天
                  </span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="divider" />

      {/* 刷新按钮 */}
      <div className="form-group">
        <button
          className="btn btn-primary"
          onClick={loadLicenseInfo}
          disabled={isLicenseLoading}
        >
          {isLicenseLoading ? (
            <><Loader2 size={16} className="spin" /> 刷新中...</>
          ) : (
            <><RefreshCw size={16} /> 刷新状态</>
          )}
        </button>
      </div>

      {/* 联系信息 */}
      {!licenseInfo?.authorized && (
        <>
          <div className="divider" />
          <div className="form-group">
            <div className="license-contact">
              <p>如需获取授权，请联系作者（洛卡）微信：</p>
              <p className="contact-info">luoka328</p>
            </div>
          </div>
        </>
      )}
    </div>
  )

  const renderInsightTab = () => (
    <div className="tab-content">
      {/* 总开关 */}
      <div className="form-group">
        <label>AI 见解</label>
        <span className="form-hint">
          开启后，AI 会在后台默默分析聊天数据，在合适的时机通过右下角弹窗送出一针见血的见解——例如提醒你久未联系的朋友，或对你刚刚的对话提出回复建议。默认关闭，所有分析均在本地发起请求，不经过任何第三方中间服务。
        </span>
        <div className="log-toggle-line">
          <span className="log-status">{aiInsightEnabled ? '已开启' : '已关闭'}</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={aiInsightEnabled}
              onChange={async (e) => {
                const val = e.target.checked
                setAiInsightEnabled(val)
                await configService.setAiInsightEnabled(val)
                showMessage(val ? 'AI 见解已开启' : 'AI 见解已关闭', true)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      <div className="divider" />

      {/* 行为配置 */}




      {/* 行为配置 */}
      <div className="form-group">
        <label>活跃触发冷却期（分钟）</label>
        <span className="form-hint">
          有新消息时触发活跃分析的冷却时间。设为 <strong>0</strong> 表示无冷却，每条新消息都可能触发见解（AI 言论自由模式）。
        </span>
        <input
          type="number"
          className="field-input"
          value={aiInsightCooldownMinutes}
          min={0}
          max={10080}
          onChange={(e) => {
            const val = Math.max(0, parseInt(e.target.value, 10) || 0)
            setAiInsightCooldownMinutes(val)
            scheduleConfigSave('aiInsightCooldownMinutes', () => configService.setAiInsightCooldownMinutes(val))
          }}
          style={{ width: 120 }}
        />
        {aiInsightCooldownMinutes === 0 && (
          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--color-warning, #f59e0b)' }}>
            无冷却 — 每次 DB 变更均可触发
          </span>
        )}
      </div>

      <div className="form-group">
        <label>沉默联系人扫描间隔（小时）</label>
        <span className="form-hint">
          多久扫描一次沉默联系人。重启生效。最小 0.1 小时（6 分钟）。
        </span>
        <input
          type="number"
          className="field-input"
          value={aiInsightScanIntervalHours}
          min={0.1}
          max={168}
          step={0.5}
          onChange={(e) => {
            const val = Math.max(0.1, parseFloat(e.target.value) || 4)
            setAiInsightScanIntervalHours(val)
            scheduleConfigSave('aiInsightScanIntervalHours', () => configService.setAiInsightScanIntervalHours(val))
          }}
          style={{ width: 120 }}
        />
      </div>

      <div className="form-group">
        <label>沉默联系人阈值（天）</label>
        <span className="form-hint">
          与某私聊联系人超过此天数没有消息往来时，触发沉默类见解。
        </span>
        <input
          type="number"
          className="field-input"
          value={aiInsightSilenceDays}
          min={1}
          max={365}
          onChange={(e) => {
            const val = Math.max(1, parseInt(e.target.value, 10) || 3)
            setAiInsightSilenceDays(val)
            scheduleConfigSave('aiInsightSilenceDays', () => configService.setAiInsightSilenceDays(val))
          }}
          style={{ width: 100 }}
        />
      </div>

      <div className="form-group">
        <label>允许发送近期对话内容用于分析</label>
        <span className="form-hint">
          开启后，触发见解时会将该联系人最近 N 条聊天记录发送给 AI，分析质量显著提升。
          <br />
          <strong>关闭时</strong>：AI 仅知道统计摘要（沉默天数等），输出质量较低。
          <br />
          <strong>开启时</strong>：聊天文本内容（不含图片、语音）会发送给大模型(默认DeepSeekV4-Flash)。
        </span>
        <div className="log-toggle-line">
          <span className="log-status">{aiInsightAllowContext ? '已授权' : '未授权'}</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={aiInsightAllowContext}
              onChange={async (e) => {
                const val = e.target.checked
                setAiInsightAllowContext(val)
                await configService.setAiInsightAllowContext(val)
              }}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      {aiInsightAllowContext && (
        <div className="form-group">
          <label>发送近期对话条数</label>
          <span className="form-hint">
            发送给 AI 的聊天记录最大条数。条数越多分析越准确，token 消耗也越多。
          </span>
          <input
            type="number"
            className="field-input"
            value={aiInsightContextCount}
            min={1}
            max={200}
            onChange={(e) => {
              const val = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 40))
              setAiInsightContextCount(val)
              scheduleConfigSave('aiInsightContextCount', () => configService.setAiInsightContextCount(val))
            }}
            style={{ width: 100 }}
          />
        </div>
      )}

      <div className="divider" />

      {/* 立即测试 */}
      <div className="form-group">
        <label>功能测试</label>
        <span className="form-hint">
          点击"立即测试"按钮，验证 AI 见解配置是否正确。测试会立即触发一次见解分析，请查看右下角弹窗。
        </span>
        <div className="log-toggle-line" style={{ marginTop: 8 }}>
          <button
            className="btn btn-primary"
            onClick={async () => {
              setIsAiInsightTesting(true)
              setAiInsightTestResult(null)
              try {
                const result = await window.electronAPI.insight.triggerTest()
                setAiInsightTestResult(result)
              } catch (e: any) {
                setAiInsightTestResult({ success: false, message: `测试失败：${e?.message || '未知错误'}` })
              } finally {
                setIsAiInsightTesting(false)
              }
            }}
            disabled={!aiInsightEnabled || isAiInsightTesting}
          >
            {isAiInsightTesting ? '测试中...' : '立即测试'}
          </button>
        </div>
        {aiInsightTestResult && (
          <div
            className="test-result"
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              fontSize: 13,
              backgroundColor: aiInsightTestResult.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              color: aiInsightTestResult.success ? 'var(--color-success, #16a34a)' : 'var(--color-error, #dc2626)',
              border: `1px solid ${aiInsightTestResult.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
            }}
          >
            <strong>{aiInsightTestResult.success ? '✓ ' : '✗ '}</strong>
            {aiInsightTestResult.message}
          </div>
        )}
      </div>

      <div className="divider" />

      {/* 对话白名单 */}
      {(() => {
        const sortedSessions = [...chatSessions].sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))
        const keyword = insightWhitelistSearch.trim().toLowerCase()
        const filteredSessions = sortedSessions.filter((s) => {
          const id = s.username?.trim() || ''
          if (!id || id.endsWith('@chatroom') || id.toLowerCase().includes('placeholder')) return false
          if (!keyword) return true
          return (
            String(s.displayName || '').toLowerCase().includes(keyword) ||
            id.toLowerCase().includes(keyword)
          )
        })
        const filteredIds = filteredSessions.map((s) => s.username)
        const selectedCount = aiInsightWhitelist.size
        const selectedInFilteredCount = filteredIds.filter((id) => aiInsightWhitelist.has(id)).length
        const allFilteredSelected = filteredIds.length > 0 && selectedInFilteredCount === filteredIds.length

        const toggleSession = (id: string) => {
          setAiInsightWhitelist((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }

        const saveWhitelist = async (next: Set<string>) => {
          await configService.setAiInsightWhitelist(Array.from(next))
        }

        const selectAllFiltered = () => {
          setAiInsightWhitelist((prev) => {
            const next = new Set(prev)
            for (const id of filteredIds) next.add(id)
            void saveWhitelist(next)
            return next
          })
        }

        const clearSelection = () => {
          const next = new Set<string>()
          setAiInsightWhitelist(next)
          void saveWhitelist(next)
        }

        return (
          <div className="anti-revoke-tab">
            <div className="insight-whitelist-hero">
              <div className="insight-whitelist-main">
                <h3>对话白名单</h3>
                <p>
                  开启后，AI 见解仅对勾选的私聊对话生效，未勾选的对话将被完全忽略。关闭时对所有私聊均生效。
                </p>
              </div>
              <div className="insight-whitelist-metrics">
                <div className="insight-whitelist-metric is-total">
                  <span className="label">私聊总数</span>
                  <span className="value">{filteredIds.length + (keyword ? 0 : 0)}</span>
                </div>
                <div className="insight-whitelist-metric is-selected">
                  <span className="label">已选中</span>
                  <span className="value">{selectedCount}</span>
                </div>
              </div>
            </div>

            <div className="log-toggle-line" style={{ marginBottom: 12 }}>
              <span className="log-status" style={{ fontWeight: 600 }}>
                {aiInsightWhitelistEnabled ? '白名单已启用（仅对勾选对话生效）' : '白名单未启用（对所有私聊生效）'}
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={aiInsightWhitelistEnabled}
                  onChange={async (e) => {
                    const val = e.target.checked
                    setAiInsightWhitelistEnabled(val)
                    await configService.setAiInsightWhitelistEnabled(val)
                  }}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="anti-revoke-control-card">
              <div className="anti-revoke-toolbar">
                <div className="filter-search-box anti-revoke-search">
                  <Search size={14} />
                  <input
                    type="text"
                    placeholder="搜索私聊对话..."
                    value={insightWhitelistSearch}
                    onChange={(e) => setInsightWhitelistSearch(e.target.value)}
                  />
                </div>
                <div className="anti-revoke-toolbar-actions">
                  <div className="anti-revoke-btn-group">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={selectAllFiltered}
                      disabled={filteredIds.length === 0 || allFilteredSelected}
                    >
                      全选
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={clearSelection}
                      disabled={selectedCount === 0}
                    >
                      清空选择
                    </button>
                  </div>
                </div>
              </div>

              <div className="anti-revoke-batch-actions">
                <div className="anti-revoke-selected-count">
                  <span>已选 <strong>{selectedCount}</strong> 个对话</span>
                  <span>筛选命中 <strong>{selectedInFilteredCount}</strong> / {filteredIds.length}</span>
                </div>
              </div>
            </div>

            <div className="anti-revoke-list">
              {filteredSessions.length === 0 ? (
                <div className="anti-revoke-empty">
                  {insightWhitelistSearch ? '没有匹配的对话' : '暂无私聊对话'}
                </div>
              ) : (
                <>
                  <div className="anti-revoke-list-header">
                    <span>对话（{filteredSessions.length}）</span>
                    <span>状态</span>
                  </div>
                  {filteredSessions.map((session) => {
                    const isSelected = aiInsightWhitelist.has(session.username)
                    return (
                      <div
                        key={session.username}
                        className={`anti-revoke-row ${isSelected ? 'selected' : ''}`}
                      >
                        <label className="anti-revoke-row-main">
                          <span className="anti-revoke-check">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={async () => {
                                setAiInsightWhitelist((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(session.username)) next.delete(session.username)
                                  else next.add(session.username)
                                  void configService.setAiInsightWhitelist(Array.from(next))
                                  return next
                                })
                              }}
                            />
                            <span className="check-indicator" aria-hidden="true">
                              <Check size={12} />
                            </span>
                          </span>
                          <Avatar
                            src={session.avatarUrl}
                            name={session.displayName || session.username}
                            size={30}
                          />
                          <div className="anti-revoke-row-text">
                            <span className="name">{session.displayName || session.username}</span>
                          </div>
                        </label>
                        <div className="anti-revoke-row-status">
                          <span className={`status-badge ${isSelected ? 'installed' : 'not-installed'}`}>
                            <i className="status-dot" aria-hidden="true" />
                            {isSelected ? '已加入' : '未加入'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          </div>
        )
      })()}

      <div className="divider" />

    </div>
  )

  return (
    <div className={`settings-modal-overlay ${isClosing ? 'closing' : ''}`} onClick={handleClose}>
      <div className={`settings-page ${isClosing ? 'closing' : ''}`} onClick={(event) => event.stopPropagation()}>
        {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

        {/* 多账号选择对话框 */}
        {showWxidSelect && wxidOptions.length > 1 && (
          <div className="wxid-dialog-overlay" onClick={() => setShowWxidSelect(false)}>
            <div className="wxid-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wxid-dialog-header">
                <h3>检测到多个微信账号</h3>
                <p>请选择要使用的账号</p>
              </div>
              <div className="wxid-dialog-list">
                {wxidOptions.map((opt) => (
                    <div
                        key={opt.wxid}
                        className={`wxid-dialog-item ${opt.wxid === wxid ? 'active' : ''}`}
                        onClick={() => handleSelectWxid(opt.wxid)}
                    >
                      <div className="wxid-profile-row">
                        {opt.avatarUrl ? (
                            <img src={opt.avatarUrl} alt="avatar" className="wxid-avatar" />
                        ) : (
                            <div className="wxid-avatar-fallback"><UserRound size={18}/></div>
                        )}
                        <div className="wxid-info-col">
                          <span className="wxid-id">{opt.nickname || opt.wxid}</span>
                          {opt.nickname && <span className="wxid-date">{opt.wxid}</span>}
                        </div>
                      </div>
                      <span className="wxid-date" style={{marginLeft: 'auto'}}>最后修改 {new Date(opt.modifiedTime).toLocaleString()}</span>
                    </div>
                ))}
              </div>
              <div className="wxid-dialog-footer">
                <button className="btn btn-secondary" onClick={() => setShowWxidSelect(false)}>取消</button>
              </div>
            </div>
          </div>
        )}

        <div className="settings-header">
          <div className="settings-title-block">
            <h1>设置</h1>
          </div>
          <div className="settings-actions">
            {onClose && (
              <button type="button" className="settings-close-btn" onClick={handleClose} aria-label="关闭设置">
                <X size={18} />
              </button>
            )}
          </div>
        </div>

        <div className="settings-layout">
          <div className="settings-tabs" role="tablist" aria-label="设置项">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <tab.icon size={16} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="settings-body">
            {activeTab === 'appearance' && renderAppearanceTab()}
            {activeTab === 'notification' && renderNotificationTab()}
            {activeTab === 'antiRevoke' && renderAntiRevokeTab()}
            {activeTab === 'database' && renderDatabaseTab()}
            {activeTab === 'models' && renderModelsTab()}
            {activeTab === 'cache' && renderCacheTab()}
            {activeTab === 'insight' && renderInsightTab()}
            {activeTab === 'license' && renderLicenseTab()}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
