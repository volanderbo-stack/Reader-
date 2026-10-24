// Зшивання кількох розпізнаних частин (фото або кадрів відео) в один документ без повторів.

import { newId } from './db.js';
import { askClaudeJson, claudeClient, explainClaudeError } from './recognize.js';

const MARK = { figure: 'F', video: 'V', qr: 'Q' };
const MARK_RE = /\[\[([FVQ]):([\w-]+)\]\]/g;

const STITCH_PROMPT = `Ти зшиваєш частини одного матеріалу, зчитані з різних фото або кадрів відео, в один документ.
Частини можуть перекриватися: той самий текст може бути на кінці однієї частини і на початку наступної,
а кадри відео часто майже повністю повторюють один одного.

Правила:
- Збери повний текст у Markdown без повторів і без пропусків. Коли дві частини містять той самий фрагмент
  з різними помилками розпізнавання, обери правильніший варіант.
- Нічого не перекладай, не скорочуй і не переказуй — лише зшивай.
- Маркери [[F:…]], [[V:…]], [[Q:…]] позначають зображення, відео та QR-коди. Кожен маркер, який залишаєш,
  став окремим рядком у тому місці тексту, де він був. Не змінюй маркери.
- Якщо те саме зображення, відео чи QR-код є в кількох частинах (однаковий опис або значення), залиш маркер
  лише один раз, а ідентифікатори решти поверни в dropped.
- Місця, де ти не впевнений у тексті, познач як [?].`;

const STITCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown', 'dropped'],
  properties: {
    markdown: { type: 'string' },
    dropped: { type: 'array', items: { type: 'string' } },
  },
};

function blockToMarker(block) {
  if (block.type === 'text') return block.markdown;
  const mark = `[[${MARK[block.type]}:${block.id}]]`;
  if (block.type === 'figure') return `${mark} (зображення: ${block.description})`;
  if (block.type === 'video') return `${mark} (відео: ${block.caption})`;
  return `${mark} (QR: ${block.value})`;
}

// Розбиває Markdown з маркерами на блоки, повертаючи відповідні оригінальні блоки на місце маркерів.
function markdownToBlocks(markdown, byId, dropped) {
  const blocks = [];
  const used = new Set();
  let last = 0;
  const pushText = (text) => {
    // Прибираємо описи в дужках, які ми самі додали після маркерів.
    const clean = text.replace(/^\s*\((зображення|відео|QR):[^\n]*\)/, '').trim();
    if (clean) blocks.push({ id: newId(), type: 'text', markdown: clean });
  };
  for (const m of markdown.matchAll(MARK_RE)) {
    pushText(markdown.slice(last, m.index));
    const block = byId.get(m[2]);
    if (block && !used.has(block.id)) {
      blocks.push(block);
      used.add(block.id);
    }
    last = m.index + m[0].length;
  }
  pushText(markdown.slice(last));
  // Маркери, які Claude загубив (а не прибрав як дублікати), додаємо в кінець, щоб нічого не втратити.
  for (const block of byId.values()) {
    if (!used.has(block.id) && !dropped.has(block.id)) blocks.push(block);
  }
  return blocks;
}

async function stitchWithClaude(fragments, { apiKey, autoOrder, onProgress }) {
  const byId = new Map();
  const parts = fragments.map((f, i) => {
    f.blocks.filter((b) => b.type !== 'text').forEach((b) => byId.set(b.id, b));
    const page = f.pageNumber ? `, номер сторінки на фото: ${f.pageNumber}` : '';
    return `=== Частина ${i + 1} (${f.label}${page}) ===\n${f.blocks.map(blockToMarker).join('\n\n')}`;
  });
  const order = autoOrder
    ? 'Частини можуть бути не по порядку — визнач правильний порядок за змістом і номерами сторінок.'
    : 'Частини вже в правильному порядку — не переставляй їх.';

  const result = await askClaudeJson(claudeClient(apiKey), {
    system: STITCH_PROMPT,
    schema: STITCH_SCHEMA,
    effort: 'medium',
    maxTokens: 64000,
    onChars: (n) => onProgress({ status: `Зшиваю частини… ${n} символів` }),
    content: [{ type: 'text', text: `${order}\n\n${parts.join('\n\n')}` }],
  });
  return markdownToBlocks(result.markdown, byId, new Set(result.dropped));
}

// ---------- Локальне зшивання (без Claude) ----------

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function bigrams(s) {
  const set = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    set.set(g, (set.get(g) ?? 0) + 1);
  }
  return set;
}

// Коефіцієнт Дайса за біграмами: стійкий до дрібних помилок розпізнавання.
function similar(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const A = bigrams(a);
  const B = bigrams(b);
  let common = 0;
  for (const [g, n] of A) common += Math.min(n, B.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + b.length - 1) >= 0.8;
}

// Непорожні рядки тексту: [нормалізований рядок, індекс у тексті].
function contentLines(lines) {
  return lines.map((line, i) => [norm(line), i]).filter(([n]) => n);
}

function mergeText(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  // Порожні рядки розпізнавач ставить по-різному на різних фото, тож порівнюємо лише рядки з текстом.
  const ac = contentLines(al);
  const bc = contentLines(bl);
  if (!bc.length) return a;

  // Якщо майже весь новий фрагмент уже є в кінці накопиченого тексту — це повтор (наприклад, той самий кадр).
  const tail = ac.slice(-400).map(([n]) => n);
  const contained = bc.filter(([line]) => tail.some((t) => similar(t, line))).length;
  if (contained / bc.length >= 0.85) return a;

  // Найдовше перекриття: кінець a збігається з початком b.
  for (let k = Math.min(ac.length, bc.length, 300); k >= 1; k--) {
    let match = 0;
    for (let i = 0; i < k; i++) {
      if (similar(ac[ac.length - k + i][0], bc[i][0])) match++;
    }
    if (match / k >= 0.8) return [...al, ...bl.slice(bc[k - 1][1] + 1)].join('\n');
  }
  return `${a}\n\n${b}`;
}

function stitchLocally(fragments) {
  const blocks = [];
  const seenCodes = new Set();
  for (const fragment of fragments) {
    fragment.blocks.forEach((block, i) => {
      const prev = blocks.at(-1);
      if (block.type === 'text' && i === 0 && prev?.type === 'text') {
        prev.markdown = mergeText(prev.markdown, block.markdown);
      } else if (block.type === 'qr') {
        if (!seenCodes.has(block.value)) {
          seenCodes.add(block.value);
          blocks.push(block);
        }
      } else {
        blocks.push({ ...block });
      }
    });
  }
  return blocks;
}

// fragments: [{ label, pageNumber, blocks }] у порядку, який задав користувач.
// Повертає { blocks, engine }.
export async function stitchFragments(fragments, { engine, apiKey, autoOrder = true, onProgress = () => {} }) {
  if (fragments.length === 1) return { blocks: fragments[0].blocks, engine: fragments[0].engine };

  let ordered = fragments;
  if (engine === 'claude' && apiKey) {
    try {
      return { blocks: await stitchWithClaude(fragments, { apiKey, autoOrder, onProgress }), engine: 'claude' };
    } catch (err) {
      const explained = explainClaudeError(err);
      if (explained) throw explained;
      onProgress({ status: 'Немає з’єднання з Claude, зшиваю локально…' });
    }
  }
  if (autoOrder && fragments.every((f) => /^\d+$/.test(f.pageNumber))) {
    ordered = [...fragments].sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber));
  }
  return { blocks: stitchLocally(ordered), engine: 'local' };
}
