/**
 * 水印工具模块
 * 在导出图片上添加不显眼的水印和二维码
 */

import QRCode from 'qrcode'

const QR_DATA_URL = 'http://luoka.icu'

export interface WatermarkOptions {
  /** Canvas 上下文 */
  ctx: CanvasRenderingContext2D
  /** 画布宽度 */
  width: number
  /** 画布高度 */
  height: number
  /** 是否深色主题 */
  isDark?: boolean
  /** 水印文字 */
  text?: string
  /** 二维码链接 */
  qrUrl?: string
}

/**
 * 生成 QR Code Canvas
 * 使用 qrcode 库生成标准二维码
 */
async function generateQRCodeCanvas(size: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  try {
    await QRCode.toCanvas(canvas, QR_DATA_URL, {
      width: size,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    })
  } catch (err) {
    console.error('QR Code 生成失败:', err)
    // 如果生成失败，返回一个空白 canvas
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
  }

  return canvas
}

/**
 * 在 Canvas 上绘制水印和二维码
 * 水印位置：右下角，不显眼不喧宾夺主
 */
export async function drawWatermark(options: WatermarkOptions): Promise<void> {
  const { ctx, width, height, isDark = false, text = 'ChatFlow', qrUrl = 'http://luoka.icu' } = options

  const padding = 24
  const qrSize = Math.min(80, width * 0.08)
  const textHeight = 16
  const gap = 8
  const totalHeight = qrSize + gap + textHeight
  const bottomY = height - padding - totalHeight
  const rightX = width - padding - qrSize

  // 半透明背景（圆角矩形）
  const bgPadding = 10
  const bgWidth = qrSize + bgPadding * 2
  const bgHeight = totalHeight + bgPadding * 2
  const bgX = rightX - bgPadding
  const bgY = bottomY - bgPadding

  ctx.save()
  ctx.globalAlpha = 0.6

  // 绘制圆角矩形背景
  const radius = 8
  ctx.beginPath()
  ctx.moveTo(bgX + radius, bgY)
  ctx.lineTo(bgX + bgWidth - radius, bgY)
  ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius)
  ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius)
  ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight)
  ctx.lineTo(bgX + radius, bgY + bgHeight)
  ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius)
  ctx.lineTo(bgX, bgY + radius)
  ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY)
  ctx.closePath()
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.9)'
  ctx.fill()

  ctx.globalAlpha = 0.5

  // 绘制二维码
  try {
    const qrCanvas = await generateQRCodeCanvas(qrSize)
    ctx.drawImage(qrCanvas, rightX, bottomY, qrSize, qrSize)
  } catch (err) {
    console.error('绘制二维码失败:', err)
  }

  // 绘制文字
  ctx.globalAlpha = 0.6
  ctx.fillStyle = isDark ? '#666666' : '#999999'
  ctx.font = `${Math.max(11, qrSize * 0.16)}px -apple-system, "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(text, rightX + qrSize / 2, bottomY + qrSize + gap + textHeight - 2)

  ctx.restore()
}
