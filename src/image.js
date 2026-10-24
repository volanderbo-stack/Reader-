// Робота із зображеннями: підготовка, вирізання фрагментів, QR-коди, оцінка різкості й схожості кадрів.

import jsQR from 'jsqr';

const MAX_SIDE = 2000;

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toJpeg(canvas, quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Будь-яке джерело (File/Blob/canvas/video) → JPEG із довшою стороною не більше MAX_SIDE.
export async function prepareImage(source, maxSide = MAX_SIDE) {
  const bitmap = source instanceof Blob
    ? await createImageBitmap(source, { imageOrientation: 'from-image' })
    : await createImageBitmap(source);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasOf(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return toJpeg(canvas);
}

export async function imageSize(blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

// box: { x0, y0, x1, y1 } у пікселях зображення.
export async function cropImage(blob, box) {
  const bitmap = await createImageBitmap(blob);
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = clamp(Math.min(box.x0, box.x1), bitmap.width);
  const x1 = clamp(Math.max(box.x0, box.x1), bitmap.width);
  const y0 = clamp(Math.min(box.y0, box.y1), bitmap.height);
  const y1 = clamp(Math.max(box.y0, box.y1), bitmap.height);
  if (x1 - x0 < 8 || y1 - y0 < 8) {
    bitmap.close();
    return null;
  }
  const canvas = canvasOf(x1 - x0, y1 - y0);
  canvas.getContext('2d').drawImage(bitmap, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  bitmap.close();
  return toJpeg(canvas);
}

function boxOfPoints(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Шукає QR-коди та штрихкоди. BarcodeDetector (Chrome/Android) знаходить усі коди,
// jsQR — запасний варіант лише для одного QR-коду. Повертає [{ value, format, box }].
export async function detectCodes(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    if ('BarcodeDetector' in window) {
      try {
        const detector = new window.BarcodeDetector();
        const found = await detector.detect(bitmap);
        if (found.length) {
          return [...new Map(found.map((c) => [c.rawValue, {
            value: c.rawValue, format: c.format, box: boxOfPoints(c.cornerPoints),
          }])).values()];
        }
      } catch {
        // Детектор недоступний на цій платформі — переходимо до jsQR.
      }
    }
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = canvasOf(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qr = jsQR(data, width, height);
    if (!qr?.data) return [];
    const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = qr.location;
    const corners = [topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner]
      .map((p) => ({ x: p.x / scale, y: p.y / scale }));
    return [{ value: qr.data, format: 'qr_code', box: boxOfPoints(corners) }];
  } finally {
    bitmap.close();
  }
}

// Зафарбовує області кодів білим, щоб текстовий розпізнавач не читав їхній візерунок як текст.
export async function maskBoxes(blob, boxes) {
  if (!boxes.length) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = canvasOf(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  ctx.fillStyle = '#fff';
  for (const { x0, y0, x1, y1 } of boxes) {
    const pad = Math.max(x1 - x0, y1 - y0) * 0.15;
    ctx.fillRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  }
  return toJpeg(canvas);
}

const THUMB = 160;

// Маленька сіра мініатюра кадру для порівняння та оцінки різкості.
export function grayThumb(source, width, height) {
  const scale = THUMB / Math.max(width, height);
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const ctx = canvasOf(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return { gray, w, h };
}

// Дисперсія лапласіана: чим більше, тим різкіший кадр.
export function sharpness({ gray, w, h }) {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// Частка пікселів, що помітно змінились між двома мініатюрами (0–1).
// На сторінках із текстом змінюється лише «чорнило», тому середня різниця тут не годиться.
export function difference(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let changed = 0;
  for (let i = 0; i < a.gray.length; i++) {
    if (Math.abs(a.gray[i] - b.gray[i]) > 40) changed++;
  }
  return changed / a.gray.length;
}
