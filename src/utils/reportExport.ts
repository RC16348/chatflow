const PATTERN_LIGHT_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><defs><style>.a{fill:none;stroke:#000;stroke-width:1.2;opacity:0.045}.b{fill:none;stroke:#000;stroke-width:1;opacity:0.035}.c{fill:none;stroke:#000;stroke-width:0.8;opacity:0.04}</style></defs><g transform='translate(45,35) rotate(-8)'><circle class='a' cx='0' cy='0' r='16'/><circle class='a' cx='-5' cy='-4' r='2.5'/><circle class='a' cx='5' cy='-4' r='2.5'/><path class='a' d='M-8 4 Q0 12 8 4'/></g><g transform='translate(320,28) rotate(15) scale(0.7)'><path class='b' d='M0 -12 l3 9 9 0 -7 5 3 9 -8 -6 -8 6 3 -9 -7 -5 9 0z'/></g><g transform='translate(180,55) rotate(12)'><path class='a' d='M0 -8 C0 -14 8 -17 12 -10 C16 -17 24 -14 24 -8 C24 4 12 14 12 14 C12 14 0 4 0 -8'/></g><g transform='translate(95,120) rotate(-5) scale(1.1)'><path class='b' d='M0 10 Q-8 10 -8 3 Q-8 -4 0 -4 Q0 -12 10 -12 Q22 -12 22 -2 Q30 -2 30 5 Q30 12 22 12 Z'/></g><g transform='translate(355,95) rotate(8)'><path class='c' d='M0 0 L0 18 M0 0 L18 -4 L18 14'/><ellipse class='c' cx='-4' cy='20' rx='6' ry='4'/><ellipse class='c' cx='14' cy='16' rx='6' ry='4'/></g><g transform='translate(250,110) rotate(-12) scale(0.9)'><rect class='b' x='0' y='0' width='26' height='18' rx='2'/><path class='b' d='M0 2 L13 11 L26 2'/></g><g transform='translate(28,195) rotate(6)'><circle class='a' cx='0' cy='0' r='11'/><path class='a' d='M-5 11 L5 11 M-4 14 L4 14'/><path class='c' d='M-3 -2 L0 -6 L3 -2'/></g><g transform='translate(155,175) rotate(-3) scale(0.85)'><path class='b' d='M0 0 L0 28 Q14 22 28 28 L28 0 Q14 6 0 0'/><path class='b' d='M28 0 L28 28 Q42 22 56 28 L56 0 Q42 6 28 0'/></g><g transform='translate(340,185) rotate(-20) scale(1.2)'><path class='a' d='M0 8 L20 0 L5 6 L8 14 L5 6 L-12 12 Z'/></g><g transform='translate(70,280) rotate(5)'><rect class='b' x='0' y='5' width='30' height='22' rx='4'/><circle class='b' cx='15' cy='16' r='7'/><rect class='b' x='8' y='0' width='14' height='6' rx='2'/><g transform='translate(200,320) rotate(-15) scale(0.8)'><circle class='a' cx='0' cy='0' r='20'/><path class='a' d='M-10 -5 L0 5 L10 -5'/></g><g transform='translate(30,360) rotate(10)'><rect class='c' x='0' y='0' width='20' height='20' rx='3'/><circle class='c' cx='10' cy='10' r='5'/></g><g transform='translate(360,340) rotate(-8)'><path class='b' d='M0 0 L15 0 L15 15 L0 15 Z'/><path class='b' d='M5 5 L10 10 M10 5 L5 10'/></g></svg>`

const PATTERN_DARK_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><defs><style>.a{fill:none;stroke:#fff;stroke-width:1.2;opacity:0.055}.b{fill:none;stroke:#fff;stroke-width:1;opacity:0.045}.c{fill:none;stroke:#fff;stroke-width:0.8;opacity:0.05}</style></defs><g transform='translate(45,35) rotate(-8)'><circle class='a' cx='0' cy='0' r='16'/><circle class='a' cx='-5' cy='-4' r='2.5'/><circle class='a' cx='5' cy='-4' r='2.5'/><path class='a' d='M-8 4 Q0 12 8 4'/></g><g transform='translate(320,28) rotate(15) scale(0.7)'><path class='b' d='M0 -12 l3 9 9 0 -7 5 3 9 -8 -6 -8 6 3 -9 -7 -5 9 0z'/></g><g transform='translate(180,55) rotate(12)'><path class='a' d='M0 -8 C0 -14 8 -17 12 -10 C16 -17 24 -14 24 -8 C24 4 12 14 12 14 C12 14 0 4 0 -8'/></g><g transform='translate(95,120) rotate(-5) scale(1.1)'><path class='b' d='M0 10 Q-8 10 -8 3 Q-8 -4 0 -4 Q0 -12 10 -12 Q22 -12 22 -2 Q30 -2 30 5 Q30 12 22 12 Z'/></g><g transform='translate(355,95) rotate(8)'><path class='c' d='M0 0 L0 18 M0 0 L18 -4 L18 14'/><ellipse class='c' cx='-4' cy='20' rx='6' ry='4'/><ellipse class='c' cx='14' cy='16' rx='6' ry='4'/></g><g transform='translate(250,110) rotate(-12) scale(0.9)'><rect class='b' x='0' y='0' width='26' height='18' rx='2'/><path class='b' d='M0 2 L13 11 L26 2'/></g><g transform='translate(28,195) rotate(6)'><circle class='a' cx='0' cy='0' r='11'/><path class='a' d='M-5 11 L5 11 M-4 14 L4 14'/><path class='c' d='M-3 -2 L0 -6 L3 -2'/></g><g transform='translate(155,175) rotate(-3) scale(0.85)'><path class='b' d='M0 0 L0 28 Q14 22 28 28 L28 0 Q14 6 0 0'/><path class='b' d='M28 0 L28 28 Q42 22 56 28 L56 0 Q42 6 28 0'/></g><g transform='translate(340,185) rotate(-20) scale(1.2)'><path class='a' d='M0 8 L20 0 L5 6 L8 14 L5 6 L-12 12 Z'/></g><g transform='translate(70,280) rotate(5)'><rect class='b' x='0' y='5' width='30' height='22' rx='4'/><circle class='b' cx='15' cy='16' r='7'/><rect class='b' x='8' y='0' width='14' height='6' rx='2'/><g transform='translate(200,320) rotate(-15) scale(0.8)'><circle class='a' cx='0' cy='0' r='20'/><path class='a' d='M-10 -5 L0 5 L10 -5'/></g><g transform='translate(30,360) rotate(10)'><rect class='c' x='0' y='0' width='20' height='20' rx='3'/><circle class='c' cx='10' cy='10' r='5'/></g><g transform='translate(360,340) rotate(-8)'><path class='b' d='M0 0 L15 0 L15 15 L0 15 Z'/><path class='b' d='M5 5 L10 10 M10 5 L5 10'/></g></svg>`

function svgToDataUrl(svg: string): string {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
}

export const drawPatternBackground = async (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bgColor: string,
  isDark: boolean
) => {
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, width, height)

  const svgString = isDark ? PATTERN_DARK_SVG : PATTERN_LIGHT_SVG
  const dataUrl = svgToDataUrl(svgString)

  return new Promise<void>((resolve) => {
    let resolved = false
    const img = new window.Image()

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }, 3000)

    img.onload = () => {
      if (resolved) return
      clearTimeout(timeoutId)
      resolved = true

      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        try {
          const pattern = ctx.createPattern(img, 'repeat')
          if (pattern) {
            ctx.fillStyle = pattern
            ctx.fillRect(0, 0, width, height)
          }
        } catch {
          // 保持纯色背景
        }
      }
      resolve()
    }

    img.onerror = () => {
      if (resolved) return
      clearTimeout(timeoutId)
      resolved = true
      resolve()
    }

    try {
      img.src = dataUrl
    } catch {
      if (!resolved) {
        clearTimeout(timeoutId)
        resolved = true
        resolve()
      }
    }
  })
}
