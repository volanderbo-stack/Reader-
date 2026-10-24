// Розпізнавання одного зображення: Claude (текст, таблиці, зображення, відео) або Tesseract (лише текст).
// QR-коди та штрихкоди завжди шукаються локально.

import Anthropic from '@anthropic-ai/sdk';
import { createWorker } from 'tesseract.js';
import { newId } from './db.js';
import { cropImage, detectCodes, imageSize, maskBoxes } from './image.js';

export const MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `Ти — система повного зчитування сторінок для застосунку «Зчитувач».
Розбери фото на блоки в тому порядку, в якому їх читає людина (зверху вниз, по колонках).

Типи блоків:
- "text": ВЕСЬ текст дослівно, мовою оригіналу, без перекладу і скорочень, у Markdown:
  заголовки, абзаци, списки, цитати. Таблиці — як Markdown-таблиці (рядки й стовпці).
  Рукописний текст теж. Нерозбірливе слово чи цифру познач як [?].
  Підписи до зображень — окремим текстовим блоком одразу після зображення.
- "figure": фото, ілюстрація, схема, графік, діаграма, логотип. У content — стислий опис
  українською (що зображено, а для графіків і схем — ключові дані). box — рамка зображення.
- "video": відеоплеєр, кадр відео з кнопкою відтворення, вбудоване відео або анімація,
  вміст яких неможливо зчитати з фото. У content — підпис або назва відео, якщо видно,
  інакше коротко, що на кадрі. box — рамка плеєра.

QR-коди та штрихкоди не описуй — їх розпізнає застосунок.
box задавай у пікселях фото (x0,y0 — лівий верхній кут, x1,y1 — правий нижній). Для "text" box = 0,0,0,0.
page_number — номер сторінки, якщо його видно на фото, інакше порожній рядок.
Якщо на фото нічого немає, поверни порожній список blocks.`;

const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x0', 'y0', 'x1', 'y1'],
  properties: {
    x0: { type: 'integer' },
    y0: { type: 'integer' },
    x1: { type: 'integer' },
    y1: { type: 'integer' },
  },
};

const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['page_number', 'blocks'],
  properties: {
    page_number: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'content', 'box'],
        properties: {
          kind: { type: 'string', enum: ['text', 'figure', 'video'] },
          content: { type: 'string' },
          box: BOX_SCHEMA,
        },
      },
    },
  },
};

export function claudeClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Перетворює помилки Claude API на зрозумілі повідомлення.
// Повертає null для помилок з'єднання — тоді викликач переходить на локальний режим.
export function explainClaudeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Ключ Claude API недійсний. Перевір його в налаштуваннях.');
  } else if (err instanceof Anthropic.RateLimitError) {
    return new Error('Забагато запитів до Claude. Зачекай хвилину і спробуй ще раз.');
  } else if (err instanceof Anthropic.APIConnectionError) {
    return null;
  } else if (err instanceof Anthropic.APIError) {
    return new Error(`Помилка Claude API (${err.status}): ${err.message}`);
  }
  return err;
}

// Спільний виклик Claude зі структурованою JSON-відповіддю.
export async function askClaudeJson(client, { system, content, schema, effort, maxTokens, onChars }) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  if (onChars) stream.on('text', (_delta, snapshot) => onChars(snapshot.length));

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude відмовився обробляти цей матеріал.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Матеріал завеликий для однієї відповіді Claude. Розбий його на менші частини.');
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return JSON.parse(text);
}

async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function recognizeWithClaude(blob, apiKey, onProgress) {
  const { width, height } = await imageSize(blob);
  const page = await askClaudeJson(claudeClient(apiKey), {
    system: SYSTEM_PROMPT,
    schema: PAGE_SCHEMA,
    effort: 'low',
    maxTokens: 32000,
    onChars: (n) => onProgress({ status: `Зчитую… ${n} символів` }),
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(blob) } },
      { type: 'text', text: `Розмір фото: ${width}×${height} пікселів. Зчитай усе.` },
    ],
  });

  const blocks = [];
  const images = [];
  for (const item of page.blocks) {
    if (item.kind === 'text') {
      if (item.content.trim()) blocks.push({ id: newId(), type: 'text', markdown: item.content.trim() });
      continue;
    }
    const crop = await cropImage(blob, item.box);
    const imageId = crop ? newId() : null;
    if (crop) images.push({ id: imageId, blob: crop });
    if (item.kind === 'figure') {
      blocks.push({ id: newId(), type: 'figure', imageId, description: item.content.trim() });
    } else {
      blocks.push({
        id: newId(), type: 'video', caption: item.content.trim(), videoId: null, posterId: imageId, originalPoster: Boolean(imageId), transcript: '',
      });
    }
  }
  return { blocks, images, pageNumber: page.page_number };
}

let tesseractWorker;
let tesseractProgress = () => {};

async function recognizeWithTesseract(blob, onProgress) {
  tesseractProgress = onProgress;
  if (!tesseractWorker) {
    onProgress({ status: 'Завантажую локальний розпізнавач (лише перший раз)…' });
    tesseractWorker = createWorker(['ukr', 'eng', 'rus'], 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          tesseractProgress({ status: `Зчитую локально… ${Math.round(m.progress * 100)}%` });
        }
      },
    });
  }
  const worker = await tesseractWorker;
  const { data } = await worker.recognize(blob);
  const text = data.text.trim();
  const pageNumber = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.match(/^\D{0,3}(\d{1,4})\D{0,3}$/)?.[1] ?? '';
  return {
    blocks: text ? [{ id: newId(), type: 'text', markdown: text }] : [],
    images: [],
    pageNumber,
  };
}

// Повертає { blocks, images: [{id, blob}], pageNumber, engine }.
export async function recognizeImage(blob, { engine, apiKey, onProgress = () => {} }) {
  let result;
  let used = 'local';
  if (engine === 'claude' && apiKey) {
    try {
      result = await recognizeWithClaude(blob, apiKey, onProgress);
      used = 'claude';
    } catch (err) {
      const explained = explainClaudeError(err);
      if (explained) throw explained;
      onProgress({ status: 'Немає з’єднання з Claude, зчитую локально…' });
    }
  }
  const codes = await detectCodes(blob);
  result ??= await recognizeWithTesseract(await maskBoxes(blob, codes.map((c) => c.box)), onProgress);

  for (const code of codes) {
    result.blocks.push({ id: newId(), type: 'qr', value: code.value, format: code.format });
  }
  return { ...result, engine: used };
}
