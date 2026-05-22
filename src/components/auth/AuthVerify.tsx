import { Loader2 } from 'lucide-react'
import './AuthVerify.scss'

interface AuthVerifyProps {
  open: boolean
  message?: string
}

export default function AuthVerify({ open, message = '正在验证授权...' }: AuthVerifyProps) {
  if (!open) return null

  return (
    <div className="auth-verify-overlay">
      <div className="auth-verify-container">
        <div className="loading-spinner">
          <Loader2 size={48} className="spinner-icon" />
        </div>
        <h3 className="verify-title">授权验证中</h3>
        <p className="verify-message">{message}</p>
        <div className="verify-progress">
          <div className="progress-bar">
            <div className="progress-indeterminate"></div>
          </div>
        </div>
      </div>
    </div>
  )
}
