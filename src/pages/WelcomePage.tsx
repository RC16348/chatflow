import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff,
  FolderOpen, FolderSearch, KeyRound, Sparkles,
  UserRound, Wand2, Minus, X, HardDrive, RotateCcw
} from 'lucide-react'
import ConfirmDialog from '../components/ConfirmDialog'
import './WelcomePage.scss'

const isMac = navigator.userAgent.toLowerCase().includes('mac')
const isLinux = navigator.userAgent.toLowerCase().includes('linux')
const isWindows = !isMac && !isLinux

const dbDirName = isMac ? '2.0b4.0.9 目录' : 'xwechat_files 目录'
const DB_PATH_CHINESE_ERROR = '路径包含中文字符，迁移至全英文目录后再试'
const dbPathPlaceholder = isMac
    ? '例如: ~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
    : isLinux
        ? '例如: ~/.local/share/WeChat/xwechat_files 或者 ~/Documents/xwechat_files'
        : '例如: C:\\Users\\xxx\\Documents\\xwechat_files'

const steps = [
  { id: 'db', title: '数据库目录', desc: '选择微信数据存储位置' },
  { id: 'key', title: '账号与密钥', desc: '选择账号并自动获取密钥' }
]
type SetupStepId = typeof steps[number]['id']

interface WelcomePageProps {
  standalone?: boolean
}

const formatDbKeyFailureMessage = (error?: string, logs?: string[]): string => {
  const base = String(error || '自动获取密钥失败').trim()
  const tailLogs = Array.isArray(logs)
    ? logs
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .slice(-6)
    : []
  if (tailLogs.length === 0) return base
  return `${base}；最近状态：${tailLogs.join(' | ')}`
}

const normalizeDbKeyStatusMessage = (message: string): string => {
  if (isWindows && message.includes('Hook安装成功')) {
    return '已准备就绪，现在登录微信或退出登录后重新登录微信'
  }
  return message
}

const isDbKeyReadyMessage = (message: string): boolean => (
  message.includes('现在可以登录')
  || message.includes('Hook安装成功')
  || message.includes('已准备就绪，现在登录微信或退出登录后重新登录微信')
)

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const { isDbConnected, setDbConnected, setLoading } = useAppStore()

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<Array<{
      avatarUrl?: string;
      nickname?: string;
      wxid: string;
      modifiedTime: number
  }>>([])
  const [showWxidSelect, setShowWxidSelect] = useState(false)
  const wxidSelectRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [isManualStartPrompt, setIsManualStartPrompt] = useState(false)
  const [imageKeyPercent, setImageKeyPercent] = useState<number | null>(null)
  const [showDbKeyConfirm, setShowDbKeyConfirm] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ stage: string; currentPath: string; scannedCount: number; foundCount: number; percentage: number } | null>(null)
  const removeProgressListenerRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const removeDb = window.electronAPI.key.onDbKeyStatus((payload: { message: string; level: number }) => {
      const normalizedMessage = normalizeDbKeyStatusMessage(payload.message)
      setDbKeyStatus(normalizedMessage)
      if (isDbKeyReadyMessage(normalizedMessage)) {
        window.electronAPI.notification?.show({
          title: 'ChatFlow 准备就绪',
          content: '现在可以登录微信了',
          avatarUrl: './logo.png',
          sessionId: 'chatflow-system'
        })
      }
    })
    const removeImage = window.electronAPI.key.onImageKeyStatus((payload: { message: string, percent?: number }) => {
      let msg = payload.message;
      let pct = payload.percent;

      // 解析文本中的百分比
      if (pct === undefined) {
        const match = msg.match(/\(([\d.]+)%\)/);
        if (match) {
          pct = parseFloat(match[1]);
          msg = msg.replace(/\s*\([\d.]+%\)/, '');
        }
      }

      setImageKeyStatus(msg);
      if (pct !== undefined) {
        setImageKeyPercent(pct);
      } else if (msg.includes('启动多核') || msg.includes('定位') || msg.includes('准备')) {
        setImageKeyPercent(0);
      }
    })
    return () => {
      removeDb?.()
      removeImage?.()
    }
  }, [])

  useEffect(() => {
    if (isDbConnected && !standalone) {
      navigate('/home')
    }
  }, [isDbConnected, standalone, navigate])

  useEffect(() => {
    setWxidOptions([])
    setWxid('')
    setShowWxidSelect(false)
  }, [dbPath])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!showWxidSelect) return
      const target = event.target as Node
      if (wxidSelectRef.current && !wxidSelectRef.current.contains(target)) {
        setShowWxidSelect(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showWxidSelect])

  const currentStep = steps[stepIndex]
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const showWindowControls = standalone

  const handleMinimize = () => {
    window.electronAPI.window.minimize()
  }

  const handleCloseWindow = () => {
    window.electronAPI.window.close()
  }

  const validatePath = (path: string): string | null => {
    if (!path) return null
    // 路径验证：只检查是否为空，不再拦截中文路径
    // 中文路径支持已通过底层编码转换实现
    return null
  }
  const dbPathValidationError = validatePath(dbPath)

  const handleDbPathChange = (value: string) => {
    setDbPath(value)
    const validationError = validatePath(value)
    if (validationError) {
      setError(validationError)
      return
    }
    if (error === DB_PATH_CHINESE_ERROR) {
      setError('')
    }
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0]
        const validationError = validatePath(selectedPath)
        setDbPath(selectedPath)
        if (validationError) {
          setError(validationError)
        } else {
          setError('')
        }
      }
    } catch (e) {
      setError('选择目录失败')
    }
  }

  const handleAutoDetectPath = async () => {
    if (isDetectingPath) return
    setIsDetectingPath(true)
    setError('')
    setScanProgress(null)
    
    // 注册进度监听
    removeProgressListenerRef.current = window.electronAPI.dbPath.onAutoDetectProgress((progress) => {
      setScanProgress(progress)
    })
    
    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        const validationError = validatePath(result.path)
        setDbPath(result.path)
        if (validationError) {
          setError(validationError)
        } else {
          setError('')
        }
      } else {
        setError(result.error || '未能检测到数据库目录')
      }
    } catch (e) {
      setError(`自动检测失败: ${e}`)
    } finally {
      setIsDetectingPath(false)
      setScanProgress(null)
      // 移除进度监听
      removeProgressListenerRef.current?.()
      removeProgressListenerRef.current = null
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择缓存目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择缓存目录失败')
    }
  }

  const handleScanWxid = async (silent = false): Promise<string | null> => {
    if (!dbPath) {
      if (!silent) setError('请先选择数据库目录')
      return null
    }
    if (isScanningWxid) return null
    setIsScanningWxid(true)
    if (!silent) setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      if (wxids.length > 0) {
        // scanWxids 已经按时间排过序了，直接取第一个
        setWxid(wxids[0].wxid)
        if (!silent) setError('')
        return wxids[0].wxid
      } else {
        if (!silent) setError('未检测到账号目录，请检查路径')
        return null
      }
    } catch (e) {
      if (!silent) setError(`扫描失败: ${e}`)
      return null
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleScanWxidCandidates = async () => {
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    if (isScanningWxid) return
    setIsScanningWxid(true)
    setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxidCandidates(dbPath)
      setWxidOptions(wxids)
      setShowWxidSelect(true)
      if (!wxids.length) {
        setError('未检测到可用的账号目录，请检查路径')
      }
    } catch (e) {
      setError(`扫描失败: ${e}`)
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async () => {
    if (isFetchingDbKey) return
    setShowDbKeyConfirm(true)
  }

  const handleDbKeyConfirm = async () => {
    setShowDbKeyConfirm(false)
    setIsFetchingDbKey(true)
    setError('')
    setIsManualStartPrompt(false)
    setDbKeyStatus('正在连接微信进程...')
    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功，正在获取图片密钥...')
        setError('')
        const scannedWxid = await handleScanWxid(true)
        // 自动获取图片密钥（使用扫描到的 wxid，避免 state 异步更新问题）
        await autoGetImageKeyAfterDbKey(scannedWxid || undefined)
      } else {
        if (result.error?.includes('未找到微信安装路径') || result.error?.includes('启动微信失败')) {
          setIsManualStartPrompt(true)
          setDbKeyStatus('需要手动启动微信')
        } else {
          if (result.error?.includes('尚未完成登录')) {
            setDbKeyStatus('请先在微信完成登录后重试')
          }
          setError(formatDbKeyFailureMessage(result.error, result.logs))
        }
      }
    } catch (e) {
      setError(`自动获取密钥失败: ${e}`)
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  // 获取解密密钥后自动获取图片密钥
  const autoGetImageKeyAfterDbKey = async (targetWxid?: string) => {
    const effectiveWxid = targetWxid || wxid
    if (!dbPath || !effectiveWxid) {
      setImageKeyStatus('跳过自动获取：未检测到账号')
      return
    }
    setIsFetchingImageKey(true)
    setImageKeyPercent(0)
    try {
      const accountPath = `${dbPath}/${effectiveWxid}`
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, effectiveWxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('图片密钥获取成功')
        setDbKeyStatus('所有密钥获取成功，可以完成配置了')
      } else {
        // 图片密钥获取失败不阻塞流程，用户可以在设置中手动配置
        console.warn('自动获取图片密钥失败:', result.error)
        setImageKeyStatus('图片密钥获取失败，可在设置中手动配置')
      }
    } catch (e) {
      console.warn('自动获取图片密钥失败:', e)
      setImageKeyStatus('图片密钥获取失败，可在设置中手动配置')
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const handleManualConfirm = async () => {
    setIsManualStartPrompt(false)
    handleAutoGetDbKey()
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) { setError('请先选择数据库目录'); return }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyPercent(0)
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.autoGetImageKey(accountPath, wxid)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('已获取图片密钥')
      } else {
        setError(result.error || '自动获取图片密钥失败')
      }
    } catch (e) {
      setError(`自动获取图片密钥失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const handleScanImageKeyFromMemory = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) { setError('请先选择数据库目录'); return }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyPercent(0)
    setImageKeyStatus('正在扫描内存...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.key.scanImageKeyFromMemory(accountPath)
      if (result.success && result.aesKey) {
        if (typeof result.xorKey === 'number') setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        setImageAesKey(result.aesKey)
        setImageKeyStatus('内存扫描成功，已获取图片密钥')
      } else {
        setError(result.error || '内存扫描获取图片密钥失败')
      }
    } catch (e) {
      setError(`内存扫描失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const jumpToStep = (stepId: SetupStepId) => {
    const targetIndex = steps.findIndex(step => step.id === stepId)
    if (targetIndex >= 0) setStepIndex(targetIndex)
  }

  const validateDbStepBeforeNext = async (): Promise<string | null> => {
    if (!dbPath) return '数据库目录步骤未完成：请先选择数据库目录'
    if (dbPathValidationError) return `数据库目录步骤配置有误：${dbPathValidationError}`
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (!Array.isArray(wxids) || wxids.length === 0) {
        return '数据库目录步骤配置有误：当前目录下未找到可用账号数据（缺少 db_storage），请重新选择微信数据目录'
      }
    } catch (e) {
      return `数据库目录步骤配置有误：目录读取失败，请确认该路径可访问（${String(e)}）`
    }
    return null
  }

  const findConfigIssueBeforeConnect = async (): Promise<{ stepId: SetupStepId; message: string } | null> => {
    const dbIssue = await validateDbStepBeforeNext()
    if (dbIssue) return { stepId: 'db', message: dbIssue }

    let scannedWxids: Array<{ wxid: string }> = []
    try {
      scannedWxids = await window.electronAPI.dbPath.scanWxids(dbPath)
    } catch {
      scannedWxids = []
    }

    if (!wxid) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请先选择微信账号 (wxid)' }
    }
    if (!scannedWxids.some(item => item.wxid === wxid)) {
      return { stepId: 'key', message: `解密密钥步骤配置有误：微信账号「${wxid}」不在当前数据库目录中，请重新选择账号` }
    }
    if (!decryptKey || decryptKey.length !== 64) {
      return { stepId: 'key', message: '解密密钥步骤未完成：请填写 64 位解密密钥' }
    }
    return null
  }

  const canGoNext = () => {
    if (currentStep.id === 'db') return Boolean(dbPath) && !dbPathValidationError
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(wxid)
    return false
  }

  const handleNext = async () => {
    if (currentStep.id === 'db') {
      const dbStepIssue = await validateDbStepBeforeNext()
      if (dbStepIssue) {
        setError(dbStepIssue)
        return
      }
    }

    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      else if (currentStep.id === 'db' && dbPathValidationError) setError(dbPathValidationError)
      if (currentStep.id === 'key') {
        if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
        else if (!wxid) setError('未能自动识别 wxid，请尝试重新获取或检查目录')
      }
      return
    }
    setError('')
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleConnect = async () => {
    const configIssue = await findConfigIssueBeforeConnect()
    if (configIssue) {
      setError(configIssue.message)
      jumpToStep(configIssue.stepId)
      return
    }

    setIsConnecting(true)
    setError('')
    setLoading(true, '正在连接数据库...')

    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        const errorMessage = result.error || 'WCDB 连接失败'
        if (errorMessage.includes('-3001')) {
          const fallbackIssue = await findConfigIssueBeforeConnect()
          if (fallbackIssue) {
            setError(fallbackIssue.message)
            jumpToStep(fallbackIssue.stepId)
          } else {
            setError(`数据库目录步骤配置有误：${errorMessage}`)
            jumpToStep('db')
          }
        } else {
          setError(errorMessage)
        }
        setLoading(false)
        return
      }

      await configService.setDbPath(dbPath)
      await configService.setDecryptKey(decryptKey)
      await configService.setMyWxid(wxid)
      // 缓存路径使用默认，不保存用户自定义路径
      // await configService.setCachePath(cachePath)
      const parsedXorKey = imageXorKey ? parseInt(imageXorKey.replace(/^0x/i, ''), 16) : null
      await configService.setImageXorKey(typeof parsedXorKey === 'number' && !Number.isNaN(parsedXorKey) ? parsedXorKey : 0)
      await configService.setImageAesKey(imageAesKey || '')
      await configService.setWxidConfig(wxid, {
        decryptKey,
        imageXorKey: typeof parsedXorKey === 'number' && !Number.isNaN(parsedXorKey) ? parsedXorKey : 0,
        imageAesKey
      })

      await configService.setOnboardingDone(true)

      setDbConnected(true, dbPath)
      setLoading(false)

      if (standalone) {
        setIsClosing(true)
        setTimeout(() => {
          window.electronAPI.window.completeOnboarding()
        }, 450)
      } else {
        navigate('/home')
      }
    } catch (e) {
      setError(`连接失败: ${e}`)
      setLoading(false)
    } finally {
      setIsConnecting(false)
    }
  }

  const formatModifiedTime = (time: number) => {
    if (!time) return '未知时间'
    const date = new Date(time)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  }

  if (isDbConnected) {
    return (
      <div className={rootClassName}>
        <div className="welcome-container">
          {showWindowControls && (
            <div className="window-controls">
              <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
                <Minus size={14} />
              </button>
              <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="welcome-sidebar">
            <div className="sidebar-header">
              <img src="./icon.png" alt="ChatFlow" className="sidebar-logo" />
              <div className="sidebar-brand">
                <span className="brand-name">ChatFlow</span>
                <span className="brand-tag">Connected</span>
              </div>
            </div>

            <div className="sidebar-spacer" style={{ flex: 1 }} />

            <div className="sidebar-footer">
              <Sparkles size={14} />
              <span>本地安全存储</span>
            </div>
          </div>

          <div className="welcome-content success-content">
            <div className="success-body">
              <div className="success-icon">
                <CheckCircle2 size={48} />
              </div>
              <h1 className="success-title">配置已完成</h1>
              <p className="success-desc">数据库已连接，你可以直接进入首页使用全部功能。</p>

              <button
                className="btn btn-primary btn-large"
                onClick={() => {
                  if (standalone) {
                    setIsClosing(true)
                    setTimeout(() => {
                      window.electronAPI.window.completeOnboarding()
                    }, 450)
                  } else {
                    navigate('/home')
                  }
                }}
              >
                进入首页 <ArrowRight size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
      <div className="welcome-container">
        {showWindowControls && (
          <div className="window-controls">
            <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
              <Minus size={14} />
            </button>
            <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="welcome-sidebar">
          <div className="sidebar-header">
            <img src="./icon.png" alt="ChatFlow" className="sidebar-logo" />
            <div className="sidebar-brand">
              <span className="brand-name">ChatFlow</span>
              <span className="brand-tag">Setup</span>
            </div>
          </div>

          <div className="sidebar-nav">
            {steps.map((step, index) => (
              <div key={step.id} className={`nav-item ${index === stepIndex ? 'active' : ''} ${index < stepIndex ? 'completed' : ''}`}>
                <div className="nav-indicator">
                  {index < stepIndex ? <CheckCircle2 size={14} /> : <div className="dot" />}
                </div>
                <div className="nav-info">
                  <div className="nav-title">{step.title}</div>
                  <div className="nav-desc">{step.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="sidebar-footer">
            <Sparkles size={14} />
            <span>数据仅在本地处理，不上传服务器</span>
          </div>
        </div>

        <div className="welcome-content">
          <div className="content-header">
            <div>
              <h2>{currentStep.title}</h2>
              <p className="header-desc">{currentStep.desc}</p>
            </div>
          </div>

          <div className="content-body">
            {currentStep.id === 'db' && (
              <div className="form-group">
                <div className="intro-welcome" style={{ marginBottom: '24px' }}>
                  <h3 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>欢迎使用 ChatFlow</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>接下来的步骤将引导你连接本地微信数据库，数据仅在本地处理，不上传服务器。</p>
                </div>
                <label className="field-label">数据库根目录</label>
                <div className="input-group">
                  <input
                    type="text"
                    className="field-input"
                    placeholder={dbPathPlaceholder}
                    value={dbPath}
                    onChange={(e) => handleDbPathChange(e.target.value)}
                  />
                </div>
                <div className="action-row">
                  <button className="btn btn-secondary" onClick={handleAutoDetectPath} disabled={isDetectingPath}>
                    <FolderSearch size={16} /> {isDetectingPath ? '检测中...' : '自动检测'}
                  </button>
                  <button className="btn btn-secondary" onClick={handleSelectPath}>
                    <FolderOpen size={16} /> 浏览...
                  </button>
                </div>

                <div className="field-hint">请选择微信-设置-存储位置对应的目录</div>

                {/* 扫描进度显示 */}
                {isDetectingPath && scanProgress && (
                  <div className="scan-progress-container">
                    <div className="scan-progress-header">
                      <span className="scan-stage">
                        {scanProgress.stage === 'c-drive' && '正在扫描 C 盘...'}
                        {scanProgress.stage === 'other-drives' && '正在扫描其他磁盘...'}
                        {scanProgress.stage === 'completed' && '扫描完成'}
                      </span>
                      <span className="scan-percentage">{scanProgress.percentage}%</span>
                    </div>
                    <div className="scan-progress-bar">
                      <div
                        className="scan-progress-fill"
                        style={{ width: `${scanProgress.percentage}%` }}
                      />
                    </div>
                    <div className="scan-progress-info">
                      <span>已扫描: {scanProgress.scannedCount} 个目录</span>
                      <span>找到: {scanProgress.foundCount} 个结果</span>
                    </div>
                    {scanProgress.currentPath && (
                      <div className="scan-current-path" title={scanProgress.currentPath}>
                        当前: {scanProgress.currentPath}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {currentStep.id === 'key' && (
              <div className="form-group">
                <label className="field-label">微信账号 (Wxid)</label>
                <div className="wxid-select" ref={wxidSelectRef}>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="点击选择..."
                    value={wxid}
                    readOnly
                    onClick={handleScanWxidCandidates}
                    onChange={(e) => setWxid(e.target.value)}
                  />
                  {showWxidSelect && wxidOptions.length > 0 && (
                      <div className="wxid-dropdown">
                        {wxidOptions.map((opt) => (
                            <button
                                key={opt.wxid}
                                type="button"
                                className={`wxid-option ${opt.wxid === wxid ? 'active' : ''}`}
                                onClick={() => {
                                  setWxid(opt.wxid)
                                  setShowWxidSelect(false)
                                }}
                            >
                              <div className="wxid-profile">
                                {opt.avatarUrl ? (
                                    <img src={opt.avatarUrl} alt="avatar" className="wxid-avatar" />
                                ) : (
                                    <div className="wxid-avatar-fallback"><UserRound size={14}/></div>
                                )}
                                <div className="wxid-info">
                                  <span className="wxid-nickname">{opt.nickname || opt.wxid}</span>
                                  {opt.nickname && <span className="wxid-sub">{opt.wxid}</span>}
                                </div>
                              </div>
                              <span className="wxid-time">{formatModifiedTime(opt.modifiedTime)}</span>
                            </button>
                        ))}
                      </div>
                  )}
                </div>

                <label className="field-label mt-4">解密密钥</label>
                <div className="field-with-toggle">
                  <input
                    type={showDecryptKey ? 'text' : 'password'}
                    className="field-input"
                    placeholder="64 位十六进制密钥"
                    value={decryptKey}
                    onChange={(e) => setDecryptKey(e.target.value.trim())}
                  />
                  <button type="button" className="toggle-btn" onClick={() => setShowDecryptKey(!showDecryptKey)}>
                    {showDecryptKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                <div className="key-actions">
                  {isManualStartPrompt ? (
                    <div className="manual-prompt">
                      <p>未能自动启动微信，请手动启动并登录</p>
                      <button className="btn btn-primary" onClick={handleManualConfirm}>
                        我已登录，继续
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-block" onClick={handleAutoGetDbKey} disabled={isFetchingDbKey}>
                      {isFetchingDbKey ? '正在获取...' : '自动获取密钥'}
                    </button>
                  )}
                </div>

                {dbKeyStatus && <div className={`status-message ${isDbKeyReadyMessage(dbKeyStatus) ? 'is-success' : ''}`}>{dbKeyStatus}</div>}
                {imageKeyStatus && <div className="status-message" style={{ marginTop: '8px' }}>{imageKeyStatus}</div>}
              </div>
            )}
          </div>

          {error && <div className="error-message">{error}</div>}

          <div className="content-actions">
            <button className="btn btn-ghost" onClick={handleBack} disabled={stepIndex === 0}>
              <ArrowLeft size={16} /> 上一步
            </button>

            {stepIndex < steps.length - 1 ? (
              <button className="btn btn-primary" onClick={handleNext} disabled={!canGoNext()}>
                下一步 <ArrowRight size={16} />
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleConnect} disabled={isConnecting || !canGoNext()}>
                {isConnecting ? '连接中...' : '完成配置'} <ArrowRight size={16} />
              </button>
            )}
          </div>
        </div>

        <ConfirmDialog
            open={showDbKeyConfirm}
            title="开始获取数据库密钥"
            message={`当开始获取后 ChatFlow 将会执行准备操作。
${isLinux ? `
【⚠️ Linux 用户特别注意】
如果您在微信里勾选了"自动登录"，请务必先关闭自动登录，然后再点击下方确认！
（因为授权弹窗输入密码需要时间，若自动登录太快会导致获取失败）
` : ''}
当 ChatFlow 内的提示条变为绿色显示允许登录或看到来自 ChatFlow 的登录通知时，请在手机上确认登录微信。`}
            onConfirm={handleDbKeyConfirm}
            onCancel={() => setShowDbKeyConfirm(false)}
        />
      </div>
    </div>
  )
}

export default WelcomePage
