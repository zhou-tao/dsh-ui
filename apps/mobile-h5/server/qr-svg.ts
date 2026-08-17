// 轻量二维码渲染：只用 qrcode 的 core（不引入 pngjs/fs，保证 ESM 打包可独立运行），
// 由模块矩阵直接输出 SVG（手机相机可直接扫描）。
// eslint-disable-next-line @typescript-eslint/no-require-imports
import QRCore from 'qrcode/lib/core/qrcode';

interface QRModules {
  size: number;
  get(row: number, col: number): boolean;
}

export interface QrSvgOptions {
  size?: number;
  margin?: number;
  dark?: string;
  light?: string;
}

export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const qr = (QRCore as unknown as { create(text: string, o: { errorCorrectionLevel: 'M' }): { modules: QRModules } }).create(text, {
    errorCorrectionLevel: 'M',
  });
  const mod = qr.modules.size;
  const margin = opts.margin ?? 2;
  const dark = opts.dark ?? '#0f172a';
  const light = opts.light ?? '#ffffff';
  const cell = opts.size ? opts.size / (mod + margin * 2) : Math.max(3, Math.round(240 / (mod + margin * 2)));
  const total = Math.round(cell * (mod + margin * 2));
  const rects: string[] = [];
  for (let r = 0; r < mod; r++) {
    for (let c = 0; c < mod; c++) {
      if (qr.modules.get(r, c)) {
        rects.push('M' + ((c + margin) * cell).toFixed(2) + ',' + ((r + margin) * cell).toFixed(2) + 'h' + cell.toFixed(2) + 'v' + cell.toFixed(2) + 'h' + (-cell).toFixed(2) + 'z');
      }
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + total + '" height="' + total + '" viewBox="0 0 ' + total + ' ' + total + '">' +
    '<rect width="100%" height="100%" fill="' + light + '"/>' +
    '<path d="' + rects.join('') + '" fill="' + dark + '"/>' +
    '</svg>'
  );
}
