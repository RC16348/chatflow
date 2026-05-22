import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation, type Location } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import RouteGuard from './components/RouteGuard'
import WelcomePage from './pages/WelcomePage'
import ChatPage from './pages/ChatPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AnalyticsWelcomePage from './pages/AnalyticsWelcomePage'
import ChatAnalyticsHubPage from './pages/ChatAnalyticsHubPage'
import AnnualReportPage from './pages/AnnualReportPage'
import AnnualReportWindow from './pages/AnnualReportWindow'
import DualReportPage from './pages/DualReportPage'
import DualReportWindow from './pages/DualReportWindow'
import GroupAnalyticsPage from './pages/GroupAnalyticsPage'
import SettingsPage from './pages/SettingsPage'
import ExportPage from './pages/ExportPage'
import VideoWindow from './pages/VideoWindow'
import ImageWindow from './pages/ImageWindow'
import SnsPage from './pages/SnsPage'
import BizPage from './pages/BizPage'
import ContactsPage from './pages/ContactsPage'
import ChatHistoryPage from './pages/ChatHistoryPage'
import NotificationWindow from './pages/NotificationWindow'
import AuthVerifyPage from './pages/AuthVerifyPage'
import AgentPage from './pages/AgentPage'

import { useAppStore } from './stores/appStore'
import { themes, useThemeStore, type ThemeId, type ThemeMode } from './stores/themeStore'
import * as configService from './services/config'
import './App.scss'

import { GlobalSessionMonitor } from './components/GlobalSessionMonitor'
import { BatchTranscribeGlobal } from './components/BatchTranscribeGlobal'
import { BatchImageDecryptGlobal } from './components/BatchImageDecryptGlobal'
import WindowCloseDialog from './components/WindowCloseDialog'

function RouteStateRedirect({ to }: { to: string }) {
  const location = useLocation()

  return <Navigate to={to} replace state={location.state} />
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const settingsBackgroundRef = useRef<Location>({
    pathname: '/chat',
    search: '',
    hash: '',
    state: null,
    key: 'settings-fallback'
  } as Location)

  const {
    setDbConnected
  } = useAppStore()

  const { currentTheme, themeMode, setTheme, setThemeMode } = useThemeStore()
  const isOnboardingWindow = location.pathname === '/onboarding-window'
  const isVideoPlayerWindow = location.pathname === '/video-player-window'
  const isChatHistoryWindow = location.pathname.startsWith('/chat-history/') || location.pathname.startsWith('/chat-history-inline/')
  const isStandaloneChatWindow = location.pathname === '/chat-window'
  const isNotificationWindow = location.pathname === '/notification-window'
  const isSettingsRoute = location.pathname === '/settings'
  const settingsRouteState = location.state as { backgroundLocation?: Location; initialTab?: unknown } | null
  const routeLocation = isSettingsRoute
    ? settingsRouteState?.backgroundLocation ?? settingsBackgroundRef.current
    : location
  const isExportRoute = routeLocation.pathname === '/export'
  const [themeHydrated, setThemeHydrated] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [canMinimizeToTray, setCanMinimizeToTray] = useState(false)

  useEffect(() => {
    if (location.pathname !== '/settings') {
      settingsBackgroundRef.current = location
    }
  }, [location])

  useEffect(() => {
    const removeCloseConfirmListener = window.electronAPI.window.onCloseConfirmRequested((payload) => {
      setCanMinimizeToTray(Boolean(payload.canMinimizeToTray))
      setShowCloseDialog(true)
    })

    return () => removeCloseConfirmListener()
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const appRoot = document.getElementById('app')

    if (isOnboardingWindow || isNotificationWindow) {
      root.style.background = 'transparent'
      body.style.background = 'transparent'
      body.style.overflow = 'hidden'
      if (appRoot) {
        appRoot.style.background = 'transparent'
        appRoot.style.overflow = 'hidden'
      }
    } else {
      root.style.background = 'var(--bg-primary)'
      body.style.background = 'var(--bg-primary)'
      body.style.overflow = ''
      if (appRoot) {
        appRoot.style.background = ''
        appRoot.style.overflow = ''
      }
    }
  }, [isOnboardingWindow])

  // 应用主题
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const applyMode = (mode: ThemeMode, systemDark?: boolean) => {
      const effectiveMode = mode === 'system' ? (systemDark ?? mq.matches ? 'dark' : 'light') : mode
      document.documentElement.setAttribute('data-theme', currentTheme)
      document.documentElement.setAttribute('data-mode', effectiveMode)
    }

    applyMode(themeMode)

    // 监听系统主题变化
    const handler = (e: MediaQueryListEvent) => {
      if (useThemeStore.getState().themeMode === 'system') {
        applyMode('system', e.matches)
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [currentTheme, themeMode, isOnboardingWindow, isNotificationWindow])

  // Windows 标题栏颜色适配
  useEffect(() => {
    if (window.electronAPI?.window?.setTitleBarOverlay) {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
      Promise.resolve(window.electronAPI.window.setTitleBarOverlay({
        symbolColor: isDark ? '#ffffff' : '#000000'
      })).catch(() => {})
    }
  }, [currentTheme, themeMode])

  // 读取已保存的主题设置
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const [savedThemeId, savedThemeMode] = await Promise.all([
          configService.getThemeId(),
          configService.getTheme()
        ])

        // 首次使用：设置默认主题为「浅色-明水鸭色」
        if (!savedThemeId) {
          setTheme('teal-water')
          await configService.setThemeId('teal-water')
        } else if (themes.some((theme) => theme.id === savedThemeId)) {
          setTheme(savedThemeId as ThemeId)
        }

        if (!savedThemeMode) {
          setThemeMode('light')
          await configService.setTheme('light')
        } else {
          setThemeMode(savedThemeMode)
        }
      } catch (e) {
        console.error('读取主题配置失败:', e)
      } finally {
        setThemeHydrated(true)
      }
    }
    loadTheme()
  }, [setTheme, setThemeMode])

  // 保存主题设置
  useEffect(() => {
    if (!themeHydrated) return
    const saveTheme = async () => {
      try {
        await Promise.all([
          configService.setThemeId(currentTheme),
          configService.setTheme(themeMode)
        ])
      } catch (e) {
        console.error('保存主题配置失败:', e)
      }
    }
    saveTheme()
  }, [currentTheme, themeMode, themeHydrated])

  const handleWindowCloseAction = async (
    action: 'tray' | 'quit' | 'cancel',
    rememberChoice = false
  ) => {
    setShowCloseDialog(false)
    if (rememberChoice && action !== 'cancel') {
      try {
        await configService.setWindowCloseBehavior(action)
      } catch (error) {
        console.error('保存关闭偏好失败:', error)
      }
    }

    try {
      await window.electronAPI.window.respondCloseConfirm(action)
    } catch (error) {
      console.error('处理关闭确认失败:', error)
    }
  }

  // 启动时自动检查配置并连接数据库
  useEffect(() => {
    if (isOnboardingWindow) return

    const autoConnect = async () => {
      try {
        const dbPath = await configService.getDbPath()
        const decryptKey = await configService.getDecryptKey()
        const wxid = await configService.getMyWxid()
        const onboardingDone = await configService.getOnboardingDone()
        const wxidConfig = wxid ? await configService.getWxidConfig(wxid) : null
        const effectiveDecryptKey = wxidConfig?.decryptKey || decryptKey

        if (wxidConfig?.decryptKey && wxidConfig.decryptKey !== decryptKey) {
          await configService.setDecryptKey(wxidConfig.decryptKey)
        }

        // 如果配置完整，自动测试连接
        if (dbPath && effectiveDecryptKey && wxid) {
          if (!onboardingDone) {
            await configService.setOnboardingDone(true)
          }

          const result = await window.electronAPI.chat.connect()

          if (result.success) {
            setDbConnected(true, dbPath)
            // 如果当前在欢迎页，跳转到聊天页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/chat')
            }
          } else {
            // 如果错误信息包含 VC++ 或数据服务相关内容，不清除配置，只提示用户
            const errorMsg = result.error || ''
            if (errorMsg.includes('Visual C++') ||
              errorMsg.includes('DLL') ||
              errorMsg.includes('Worker') ||
              errorMsg.includes('126') ||
              errorMsg.includes('模块')) {
              console.warn('检测到可能的运行时依赖问题:', errorMsg)
            }
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
      }
    }

    autoConnect()
  }, [isOnboardingWindow, navigate, setDbConnected])

  if (isOnboardingWindow) {
    return <WelcomePage standalone />
  }

  // 独立视频播放窗口
  if (isVideoPlayerWindow) {
    return <VideoWindow />
  }

  // 独立图片查看窗口
  const isImageViewerWindow = location.pathname === '/image-viewer-window'
  if (isImageViewerWindow) {
    return <ImageWindow />
  }

  // 独立聊天记录窗口
  if (isChatHistoryWindow) {
    return <ChatHistoryPage />
  }

  // 独立会话聊天窗口（仅显示聊天内容区域）
  if (isStandaloneChatWindow) {
    const params = new URLSearchParams(location.search)
    const sessionId = params.get('sessionId') || ''
    const standaloneSource = params.get('source')
    const standaloneInitialDisplayName = params.get('initialDisplayName')
    const standaloneInitialAvatarUrl = params.get('initialAvatarUrl')
    const standaloneInitialContactType = params.get('initialContactType')
    return (
      <ChatPage
        standaloneSessionWindow
        initialSessionId={sessionId}
        standaloneSource={standaloneSource}
        standaloneInitialDisplayName={standaloneInitialDisplayName}
        standaloneInitialAvatarUrl={standaloneInitialAvatarUrl}
        standaloneInitialContactType={standaloneInitialContactType}
      />
    )
  }

  // 独立通知窗口
  if (isNotificationWindow) {
    return <NotificationWindow />
  }

  // 授权验证窗口
  const isAuthVerifyWindow = location.pathname === '/auth-verify'
  if (isAuthVerifyWindow) {
    return <AuthVerifyPage />
  }

  // 主窗口 - 完整布局
  const handleCloseSettings = () => {
    const backgroundLocation = settingsRouteState?.backgroundLocation ?? settingsBackgroundRef.current
    if (backgroundLocation.pathname === '/settings') {
      navigate('/chat', { replace: true })
      return
    }
    navigate(
      {
        pathname: backgroundLocation.pathname,
        search: backgroundLocation.search,
        hash: backgroundLocation.hash
      },
      {
        replace: true,
        state: backgroundLocation.state
      }
    )
  }

  return (
    <div className="app-container">
      <div className="window-drag-region" aria-hidden="true" />
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
      />

      {/* 全局会话监听与通知 */}
      <GlobalSessionMonitor />

      {/* 全局批量转写进度浮窗 */}
      <BatchTranscribeGlobal />
      <BatchImageDecryptGlobal />

      <WindowCloseDialog
        open={showCloseDialog}
        canMinimizeToTray={canMinimizeToTray}
        onSelect={(action, rememberChoice) => handleWindowCloseAction(action, rememberChoice)}
        onCancel={() => handleWindowCloseAction('cancel')}
      />

      <div className="main-layout">
        <Sidebar collapsed={sidebarCollapsed} />
        <main className="content">
          <RouteGuard>
            <div className={`export-keepalive-page ${isExportRoute ? 'active' : 'hidden'}`} aria-hidden={!isExportRoute}>
              <ExportPage />
            </div>

            <Routes location={routeLocation}>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatPage />} />

              <Route path="/analytics" element={<ChatAnalyticsHubPage />} />
              <Route path="/analytics/private" element={<AnalyticsWelcomePage />} />
              <Route path="/analytics/private/view" element={<AnalyticsPage />} />
              <Route path="/analytics/group" element={<GroupAnalyticsPage />} />
              <Route path="/analytics/view" element={<RouteStateRedirect to="/analytics/private/view" />} />
              <Route path="/group-analytics" element={<RouteStateRedirect to="/analytics/group" />} />
              <Route path="/annual-report" element={<AnnualReportPage />} />
              <Route path="/annual-report/view" element={<AnnualReportWindow />} />
              <Route path="/dual-report" element={<DualReportPage />} />
              <Route path="/dual-report/view" element={<DualReportWindow />} />

              <Route path="/export" element={<div className="export-route-anchor" aria-hidden="true" />} />
              <Route path="/sns" element={<SnsPage />} />
              <Route path="/biz" element={<BizPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/chat-history/:sessionId/:messageId" element={<ChatHistoryPage />} />
              <Route path="/chat-history-inline/:payloadId" element={<ChatHistoryPage />} />
            </Routes>
          </RouteGuard>
        </main>
      </div>

      {isSettingsRoute && (
        <SettingsPage onClose={handleCloseSettings} />
      )}
    </div>
  )
}

export default App
