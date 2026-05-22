import { useState, useEffect, useCallback } from 'react'
import { Loader2, X, Copy, Check, RefreshCw, LogOut } from 'lucide-react'
import './AuthVerifyPage.scss'

interface AuthVerifyResult {
  authorized: boolean
  message: string
  uuid?: string
  license_key?: string
  duration_type?: string
  duration_label?: string
  activated_at?: string
  expires_at?: string
  remaining_days?: number
  contact?: string
  expired_at?: string
}

const WECHAT_ID = 'luoka328'
const AUTHOR_NAME = '洛卡'
const REMARK = 'ChatFlow授权'

export default function AuthVerifyPage() {
  const [loading, setLoading] = useState(true)
  const [verifyResult, setVerifyResult] = useState<AuthVerifyResult | null>(null)
  const [copiedWechat, setCopiedWechat] = useState(false)
  const [copiedUUID, setCopiedUUID] = useState(false)
  const [machineUUID, setMachineUUID] = useState<string>('')
  const [uuidError, setUuidError] = useState<string>('')
  const [retryCount, setRetryCount] = useState(0)

  const performVerify = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.licenseAuth.verify()
      setVerifyResult(result)
    } catch (error) {
      setVerifyResult({
        authorized: false,
        message: error instanceof Error ? error.message : '验证失败'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // 获取机器UUID
  useEffect(() => {
    const fetchUUID = async () => {
      try {
        console.log('[AuthVerifyPage] 开始获取机器UUID...')
        const result = await window.electronAPI.licenseAuth.getMachineUUID()
        console.log('[AuthVerifyPage] 获取结果:', result)
        if (result.success && result.uuid) {
          setMachineUUID(result.uuid)
          setUuidError('')
        } else {
          setUuidError(result.error || '获取失败')
        }
      } catch (error) {
        console.error('[AuthVerifyPage] 获取机器UUID失败:', error)
        setUuidError(error instanceof Error ? error.message : '获取失败')
      }
    }
    fetchUUID()
  }, [])

  useEffect(() => {
    performVerify()
  }, [performVerify, retryCount])

  const handleCopyWechatId = async () => {
    try {
      if (!WECHAT_ID) {
        alert('微信号为空，无法复制')
        return
      }
      await window.electronAPI.licenseAuth.copyToClipboard(WECHAT_ID)
      setCopiedWechat(true)
      // 验证复制是否成功
      const clipboardText = await navigator.clipboard.readText()
      if (clipboardText === WECHAT_ID) {
        console.log('[AuthVerifyPage] 微信号复制成功:', WECHAT_ID)
      }
      setTimeout(() => setCopiedWechat(false), 2000)
    } catch (error) {
      console.error('[AuthVerifyPage] 复制微信号失败:', error)
      // 降级方案：使用原生 clipboard API
      try {
        await navigator.clipboard.writeText(WECHAT_ID)
        setCopiedWechat(true)
        setTimeout(() => setCopiedWechat(false), 2000)
      } catch (e) {
        alert('复制失败，请手动复制微信号: ' + WECHAT_ID)
      }
    }
  }

  const handleCopyUUID = async () => {
    if (!machineUUID) {
      alert('机器码尚未获取成功，请稍后再试')
      return
    }
    try {
      await window.electronAPI.licenseAuth.copyToClipboard(machineUUID)
      setCopiedUUID(true)
      // 验证复制是否成功
      const clipboardText = await navigator.clipboard.readText()
      if (clipboardText === machineUUID) {
        console.log('[AuthVerifyPage] 机器码复制成功:', machineUUID)
      }
      setTimeout(() => setCopiedUUID(false), 2000)
    } catch (error) {
      console.error('[AuthVerifyPage] 复制机器码失败:', error)
      // 降级方案：使用原生 clipboard API
      try {
        await navigator.clipboard.writeText(machineUUID)
        setCopiedUUID(true)
        setTimeout(() => setCopiedUUID(false), 2000)
      } catch (e) {
        alert('复制失败，请手动复制机器码: ' + machineUUID)
      }
    }
  }

  const handleRetry = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.licenseAuth.retryVerify()
      setVerifyResult(result)
      
      // 如果验证成功，窗口会被主进程关闭，这里不需要额外处理
      if (!result.authorized) {
        setLoading(false)
      }
    } catch (error) {
      setVerifyResult({
        authorized: false,
        message: error instanceof Error ? error.message : '验证失败'
      })
      setLoading(false)
    }
  }

  const handleQuit = async () => {
    await window.electronAPI.licenseAuth.quitApp()
  }

  // 验证中状态
  if (loading) {
    return (
      <div className="auth-verify-page">
        <div className="auth-verify-container">
          <div className="loading-spinner">
            <Loader2 size={48} className="spinner-icon" />
          </div>
          <h3 className="verify-title">授权验证中</h3>
          <p className="verify-message">正在连接云端授权服务器...</p>
          <div className="verify-progress">
            <div className="progress-bar">
              <div className="progress-indeterminate"></div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 验证失败状态
  if (!verifyResult?.authorized) {
    return (
      <div className="auth-verify-page failed">
        <div className="auth-failed-container">
          <div className="dialog-header">
            <div className="error-icon">
              <X size={32} />
            </div>
            <h2 className="dialog-title">授权验证失败</h2>
          </div>

          <div className="dialog-content">
            <div className="error-message">
              <p>{verifyResult?.message || '未获取到授权信息'}</p>
            </div>

            <div className="contact-info">
              <h3>联系作者获取授权</h3>
              <div className="contact-details">
                <div className="contact-item">
                  <span className="label">作者：</span>
                  <span className="value">{AUTHOR_NAME}</span>
                </div>
                <div className="contact-item">
                  <span className="label">微信号：</span>
                  <span className="value wechat-id">{WECHAT_ID}</span>
                  <button 
                    className="copy-btn"
                    onClick={handleCopyWechatId}
                    title="复制微信号"
                  >
                    {copiedWechat ? <Check size={16} /> : <Copy size={16} />}
                    <span>{copiedWechat ? '已复制' : '复制'}</span>
                  </button>
                </div>
                <div className="contact-item">
                  <span className="label">备注：</span>
                  <span className="value remark">【{REMARK}】</span>
                </div>
              </div>
            </div>

            <div className="uuid-info">
              <h3>您的机器码</h3>
              <p className="uuid-hint">请复制以下机器码发送给作者进行授权</p>
              <div className="uuid-details">
                <div className="uuid-value" style={{ 
                  color: uuidError ? '#e74c3c' : machineUUID ? '#2ecc71' : 'inherit',
                  fontFamily: 'monospace',
                  fontSize: '14px'
                }}>
                  {uuidError ? `获取失败: ${uuidError}` : (machineUUID || '获取中...')}
                </div>
                <button 
                  className="copy-btn uuid-copy-btn"
                  onClick={handleCopyUUID}
                  disabled={!machineUUID}
                  title={machineUUID ? '复制机器码' : '机器码尚未获取成功'}
                  style={{
                    backgroundColor: copiedUUID ? '#2ecc71' : undefined,
                    transition: 'all 0.3s ease'
                  }}
                >
                  {copiedUUID ? <Check size={16} /> : <Copy size={16} />}
                  <span>{copiedUUID ? '✓ 已复制到剪贴板' : '复制机器码'}</span>
                </button>
              </div>
              {copiedUUID && (
                <div style={{ 
                  marginTop: '8px', 
                  color: '#2ecc71', 
                  fontSize: '12px',
                  textAlign: 'center'
                }}>
                  ✅ 机器码已成功复制，请粘贴发送给作者
                </div>
              )}
            </div>
          </div>

          <div className="dialog-actions">
            <button className="btn-quit" onClick={handleQuit}>
              <LogOut size={18} />
              <span>退出应用</span>
            </button>
            <button className="btn-retry" onClick={handleRetry}>
              <RefreshCw size={18} />
              <span>重新验证</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 验证成功（理论上不会显示，因为成功后会关闭窗口）
  return (
    <div className="auth-verify-page success">
      <div className="auth-success-container">
        <div className="success-icon">✓</div>
        <h3 className="success-title">授权验证成功</h3>
        <p className="success-message">正在进入应用...</p>
      </div>
    </div>
  )
}
