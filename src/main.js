import './style.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  newId, saveDocument, getDocument, listDocuments, getImage, getVideo, deleteDocument, deleteMedia,
} from './db.js';
import { prepareImage } from './image.js';
import { recognizeImage } from './recognize.js';
import { stitchFragments } from './stitch.js';
import { extractFrames, formatTime, posterOf, canRecord, openRecorder } from './video.js';
// Експорт (docx, zip) важкий — завантажуємо лише коли він потрібен.
const loadExport = () => import('./export.js');

const app = document.getElementById('app');

// ---------- Налаштування (лише на цьому пристрої) ----------

const SETTINGS_KEY = 'zchytuvach.settings';

function loadSettings() {
  try {
    return { engine: 'claude', apiKey: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { engine: 'claude', apiKey: '' };
  }
}

function storeSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

// ---------- Допоміжне ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' });
}

function makeTitle(blocks, createdAt) {
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.markdown).join('\n');
  const line = text.split('\n').map((l) => l.replace(/^[#>*\-\s|]+/, '').trim()).find(Boolean);
  if (!line) return `Документ від ${formatDate(createdAt)}`;
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function renderMarkdown(md) {
  // breaks: розпізнаний текст зберігає переноси рядків, як на сторінці.
  return DOMPurify.sanitize(marked.parse(md, { breaks: true }))
    .replaceAll('[?]', '<mark class="unsure" title="Невпевнено розпізнано — перевір">[?]</mark>');
}

const ENGINE_LABEL = { claude: 'Claude', local: 'Локально' };

let objectUrls = [];
function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}
function releaseUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

function header(title, { back = false } = {}) {
  return `
    <header class="bar">
      ${back ? '<a class="icon-btn" href="#/" aria-label="Назад">←</a>' : '<span class="logo">📖</span>'}
      <h1>${esc(title)}</h1>
      <a class="icon-btn" href="#/settings" aria-label="Налаштування">⚙</a>
    </header>`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// Увесь текст документа для пошуку: текст, описи зображень, підписи й розшифровки відео, QR, теги.
function searchableText(doc) {
  const blockText = {
    text: (b) => b.markdown,
    figure: (b) => b.description,
    video: (b) => `${b.caption} ${b.transcript}`,
    qr: (b) => b.value,
  };
  return [doc.title, doc.folder, ...doc.tags, ...doc.blocks.map((b) => blockText[b.type]?.(b))]
    .filter(Boolean).join('\n');
}

function emptySlots(doc) {
  return doc.blocks.filter((b) => b.type === 'video' && !b.videoId).length;
}

function unsureCount(doc) {
  return doc.blocks.reduce((n, b) => n + (b.markdown?.split('[?]').length - 1 || 0), 0);
}

// ---------- Бібліотека ----------

const libraryState = { query: '', folder: '', tag: '' };

async function renderLibrary() {
  const docs = await listDocuments();
  const folders = [...new Set(docs.map((d) => d.folder).filter(Boolean))].sort();
  const tags = [...new Set(docs.flatMap((d) => d.tags))].sort();
  if (!folders.includes(libraryState.folder)) libraryState.folder = '';
  if (!tags.includes(libraryState.tag)) libraryState.tag = '';

  const chip = (kind, value, label) => `
    <button class="chip ${libraryState[kind] === value ? 'on' : ''}" data-${kind}="${esc(value)}">${esc(label)}</button>`;

  app.innerHTML = `
    ${header('Зчитувач')}
    <main>
      <a class="primary big" href="#/new">＋ Нове зчитування</a>
      ${docs.length ? `
        <input id="search" class="search" type="search" placeholder="Пошук у всіх текстах, описах і відео…" value="${esc(libraryState.query)}">
        ${folders.length ? `<div class="chips" aria-label="Папки">📁 ${chip('folder', '', 'Усі')}${folders.map((f) => chip('folder', f, f)).join('')}</div>` : ''}
        ${tags.length ? `<div class="chips" aria-label="Теги">🏷 ${chip('tag', '', 'Усі')}${tags.map((t) => chip('tag', t, `#${t}`)).join('')}</div>` : ''}
      ` : ''}
      <ul class="doc-list" id="list"></ul>
      ${docs.length ? '' : '<p class="empty">Бібліотека порожня. Сфотографуй сторінку або зніми відео, щоб почати.</p>'}
    </main>`;

  const list = document.getElementById('list');
  const draw = () => {
    const q = libraryState.query.trim().toLowerCase();
    const shown = docs.filter((d) => (!libraryState.folder || d.folder === libraryState.folder)
      && (!libraryState.tag || d.tags.includes(libraryState.tag)));
    const items = shown.map((d) => {
      const text = searchableText(d);
      const idx = q ? text.toLowerCase().indexOf(q) : 0;
      if (idx < 0) return '';
      const start = Math.max(0, idx - 40);
      const snippet = q
        ? `${start ? '…' : ''}${esc(text.slice(start, idx))}<mark>${esc(text.slice(idx, idx + q.length))}</mark>${esc(text.slice(idx + q.length, idx + q.length + 100))}`
        : esc(d.blocks.find((b) => b.type === 'text')?.markdown.slice(0, 140) ?? '');
      const slots = emptySlots(d);
      return `
        <li><a href="#/doc/${d.id}">
          <strong>${esc(d.title)}</strong>
          <span class="snippet">${snippet}</span>
          <span class="meta">
            ${formatDate(d.createdAt)} · ${ENGINE_LABEL[d.engine] ?? d.engine}
            ${d.folder ? ` · 📁 ${esc(d.folder)}` : ''}
            ${d.tags.map((t) => ` <span class="tag">#${esc(t)}</span>`).join('')}
            ${slots ? ` · <span class="badge">🎬 потрібен запис: ${slots}</span>` : ''}
          </span>
        </a></li>`;
    }).join('');
    list.innerHTML = items || (docs.length ? '<li class="empty">Нічого не знайдено.</li>' : '');
  };
  draw();

  document.getElementById('search')?.addEventListener('input', (e) => {
    libraryState.query = e.target.value;
    draw();
  });
  app.querySelectorAll('[data-folder], [data-tag]').forEach((btn) => btn.addEventListener('click', () => {
    if ('folder' in btn.dataset) libraryState.folder = btn.dataset.folder;
    else libraryState.tag = btn.dataset.tag;
    renderLibrary();
  }));
}

// ---------- Нове зчитування: збір частин ----------

// Частини поточної сесії: { id, blob, label, kind: 'photo'|'frame' }.
const session = { parts: [], autoOrder: true, busy: false };
let videoCounter = 0;

function renderNew() {
  const settings = loadSettings();
  const usingClaude = settings.engine === 'claude' && settings.apiKey;
  app.innerHTML = `
    ${header('Нове зчитування', { back: true })}
    <main>
      <div class="pick">
        <label class="primary">📷 Сфотографувати
          <input data-add="photo" type="file" accept="image/*" capture="environment" hidden></label>
        <label class="secondary">🖼 Фото з галереї
          <input data-add="photo" type="file" accept="image/*" multiple hidden></label>
        <label class="secondary">🎥 Зняти відео
          <input data-add="video" type="file" accept="video/*" capture="environment" hidden></label>
        <label class="secondary">🎞 Відео з файлу
          <input data-add="video" type="file" accept="video/*" multiple hidden></label>
      </div>
      <p class="hint">Додай одне чи кілька фото або відео одного матеріалу — частини буде зшито в один документ.
        ${usingClaude
          ? 'Розпізнавання: Claude (текст, таблиці, зображення, відео).'
          : 'Розпізнавання: локально (лише текст і QR-коди). Для повного зчитування додай ключ Claude API в <a href="#/settings">налаштуваннях</a>.'}</p>
      <p id="status" class="status"></p>
      <section id="parts-section" ${session.parts.length ? '' : 'hidden'}>
        <h2 class="section-title">Частини (<span id="count">${session.parts.length}</span>)</h2>
        <ol id="parts" class="parts"></ol>
        <label class="check"><input id="auto-order" type="checkbox" ${session.autoOrder ? 'checked' : ''}>
          Визначити порядок автоматично (за змістом і номерами сторінок)</label>
        <div class="actions">
          <button id="process" class="primary">Зчитати і зібрати документ</button>
          <button id="clear" class="secondary">Очистити</button>
        </div>
      </section>
    </main>`;

  drawParts();
  app.querySelectorAll('input[data-add]').forEach((input) => input.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await addFiles(files, input.dataset.add);
  }));
  document.getElementById('auto-order').addEventListener('change', (e) => { session.autoOrder = e.target.checked; });
  document.getElementById('clear').addEventListener('click', () => {
    session.parts = [];
    renderNew();
  });
  document.getElementById('process').addEventListener('click', () => processSession(settings));
}

function setStatus(text, error = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function setBusy(busy) {
  session.busy = busy;
  app.querySelectorAll('.pick, #parts-section').forEach((el) => el.classList.toggle('busy', busy));
}

async function addFiles(files, kind) {
  setBusy(true);
  try {
    for (const file of files) {
      if (kind === 'photo') {
        setStatus('Готую фото…');
        const n = session.parts.filter((p) => p.kind === 'photo').length + 1;
        session.parts.push({ id: newId(), blob: await prepareImage(file), label: `Фото ${n}`, kind: 'photo' });
      } else {
        const v = ++videoCounter;
        const frames = await extractFrames(file, { onProgress: ({ status }) => setStatus(`Відео ${v}: ${status}`) });
        frames.forEach((f) => session.parts.push({
          id: newId(), blob: f.blob, label: `Відео ${v} · кадр ${formatTime(f.time)}`, kind: 'frame',
        }));
        setStatus(`З відео ${v} вибрано ${frames.length} чітких кадрів.`);
        continue;
      }
      setStatus('');
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Не вдалося додати файл.', true);
  } finally {
    setBusy(false);
    drawParts();
  }
}

function drawParts() {
  const list = document.getElementById('parts');
  if (!list) return;
  document.getElementById('parts-section').hidden = !session.parts.length;
  document.getElementById('count').textContent = session.parts.length;
  list.innerHTML = session.parts.map((p, i) => `
    <li>
      <img src="${blobUrl(p.blob)}" alt="">
      <span>${esc(p.label)}</span>
      <span class="tools">
        <button class="icon" data-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Вище">↑</button>
        <button class="icon" data-move="1" data-i="${i}" ${i === session.parts.length - 1 ? 'disabled' : ''} aria-label="Нижче">↓</button>
        <button class="icon" data-remove="${i}" aria-label="Прибрати">✕</button>
      </span>
    </li>`).join('');
  list.querySelectorAll('[data-move]').forEach((btn) => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.i);
    const j = i + Number(btn.dataset.move);
    [session.parts[i], session.parts[j]] = [session.parts[j], session.parts[i]];
    session.autoOrder = false;
    document.getElementById('auto-order').checked = false;
    drawParts();
  }));
  list.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
    session.parts.splice(Number(btn.dataset.remove), 1);
    drawParts();
  }));
}

async function processSession(settings) {
  const parts = [...session.parts];
  if (!parts.length || session.busy) return;
  setBusy(true);
  try {
    const useClaude = settings.engine === 'claude' && settings.apiKey;
    let done = 0;
    const fragments = await mapLimit(parts, useClaude ? 3 : 1, async (part) => {
      const result = await recognizeImage(part.blob, {
        engine: settings.engine,
        apiKey: settings.apiKey,
        onProgress: ({ status }) => setStatus(`Зчитано ${done} з ${parts.length}. ${status}`),
      });
      done++;
      setStatus(`Зчитано ${done} з ${parts.length}.`);
      return { label: part.label, ...result };
    });

    const { blocks, engine } = await stitchFragments(fragments, {
      engine: settings.engine,
      apiKey: settings.apiKey,
      autoOrder: session.autoOrder,
      onProgress: ({ status }) => setStatus(status),
    });

    // Зберігаємо лише ті вирізані зображення, які залишились у документі після зшивання.
    const usedImages = new Set(blocks.flatMap((b) => [b.imageId, b.posterId]).filter(Boolean));
    const images = [
      ...parts.map((p) => ({ id: p.id, blob: p.blob })),
      ...fragments.flatMap((f) => f.images).filter((img) => usedImages.has(img.id)),
    ];
    const now = Date.now();
    const anyClaude = engine === 'claude' || fragments.some((f) => f.engine === 'claude');
    const doc = {
      id: newId(),
      title: makeTitle(blocks, now),
      folder: '',
      tags: [],
      engine: anyClaude ? 'claude' : 'local',
      blocks,
      sources: parts.map((p) => ({ imageId: p.id, kind: p.kind, label: p.label })),
      createdAt: now,
      updatedAt: now,
    };
    await saveDocument(doc, { images });
    session.parts = [];
    session.autoOrder = true;
    session.busy = false;
    location.hash = `#/doc/${doc.id}`;
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Не вдалося зчитати.', true);
    setBusy(false);
  }
}

// ---------- Документ ----------

let currentDoc = null;
const editing = new Set();

async function saveCurrent(extra) {
  await saveDocument(currentDoc, extra);
}

async function renderDocument(id) {
  const doc = await getDocument(id);
  if (!doc) {
    location.hash = '#/';
    return;
  }
  if (currentDoc?.id !== id) editing.clear();
  releaseUrls();
  currentDoc = doc;
  const folders = [...new Set((await listDocuments()).map((d) => d.folder).filter(Boolean))];
  const slots = emptySlots(doc);
  const unsure = unsureCount(doc);

  app.innerHTML = `
    ${header('Документ', { back: true })}
    <main class="doc">
      <h1 class="print-only">${esc(doc.title)}</h1>
      <input id="title" class="title-input no-print" value="${esc(doc.title)}" aria-label="Назва">
      <div class="doc-fields no-print">
        <label>📁 <input id="folder" list="folders" placeholder="Папка" value="${esc(doc.folder)}"></label>
        <datalist id="folders">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
        <label>🏷 <input id="tags" placeholder="теги через кому" value="${esc(doc.tags.join(', '))}"></label>
      </div>
      <p class="meta">${formatDate(doc.createdAt)} · ${ENGINE_LABEL[doc.engine] ?? doc.engine} · частин: ${doc.sources.length}
        ${slots ? ` · <span class="badge">🎬 потрібен запис: ${slots}</span>` : ''}
        ${unsure ? ` · <span class="badge warn">⚠ невпевнених місць: ${unsure}</span>` : ''}</p>
      <div class="actions no-print">
        <select id="export" class="secondary" aria-label="Експорт">
          <option value="">⬇ Експорт…</option>
          <option value="pdf">PDF (друк)</option>
          <option value="docx">Word (DOCX)</option>
          <option value="md">Markdown + фото й відео (ZIP)</option>
          <option value="txt">Текст (TXT)</option>
        </select>
        <button data-action="copy" class="secondary">Копіювати текст</button>
        <button data-action="delete-doc" class="danger">Видалити</button>
      </div>
      <p id="note" class="status no-print"></p>
      <div id="blocks" class="blocks"></div>
      ${doc.sources.length ? `
        <details class="sources no-print">
          <summary>Оригінальні фото й кадри (${doc.sources.length})</summary>
          <div class="source-grid" id="sources"></div>
        </details>` : ''}
    </main>
    <div id="recorder" class="modal" hidden></div>`;

  await drawBlocks();
  drawSources();

  const saveMeta = async () => {
    doc.title = document.getElementById('title').value.trim() || doc.title;
    doc.folder = document.getElementById('folder').value.trim();
    doc.tags = [...new Set(document.getElementById('tags').value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
    await saveCurrent();
    flash('Збережено ✓');
  };
  ['title', 'folder', 'tags'].forEach((f) => document.getElementById(f).addEventListener('change', saveMeta));

  document.getElementById('export').addEventListener('change', async (e) => {
    const kind = e.target.value;
    e.target.value = '';
    try {
      if (kind === 'pdf') window.print();
      else if (kind === 'docx') await (await loadExport()).exportDocx(doc);
      else if (kind === 'md') await (await loadExport()).exportMarkdownZip(doc);
      else if (kind === 'txt') (await loadExport()).exportText(doc);
    } catch (err) {
      console.error(err);
      flash(`Не вдалося експортувати: ${err.message}`);
    }
  });
}

async function drawSources() {
  const grid = document.getElementById('sources');
  if (!grid) return;
  const items = await Promise.all(currentDoc.sources.map(async (s) => {
    const blob = await getImage(s.imageId);
    if (!blob) return '';
    const url = blobUrl(blob);
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt=""><span>${esc(s.label)}</span></a>`;
  }));
  grid.innerHTML = items.join('');
}

function flash(msg) {
  const note = document.getElementById('note');
  if (!note) return;
  note.textContent = msg;
  setTimeout(() => { if (note.textContent === msg) note.textContent = ''; }, 2500);
}

const insertRow = (at) => `
  <div class="insert no-print">
    <button data-insert="text" data-at="${at}">＋ текст</button>
    <button data-insert="video" data-at="${at}">＋ відеослот</button>
  </div>`;

async function blockHtml(block, i, total) {
  const isEditing = editing.has(block.id);
  const canEdit = block.type !== 'qr';
  const tools = `
    <div class="block-tools no-print">
      <button class="icon" data-action="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Вище">↑</button>
      <button class="icon" data-action="down" data-i="${i}" ${i === total - 1 ? 'disabled' : ''} aria-label="Нижче">↓</button>
      ${canEdit ? `<button class="icon" data-action="${isEditing ? 'done' : 'edit'}" data-i="${i}" aria-label="${isEditing ? 'Готово' : 'Редагувати'}">${isEditing ? '✓' : '✎'}</button>` : ''}
      <button class="icon" data-action="remove" data-i="${i}" aria-label="Видалити блок">✕</button>
    </div>`;

  if (block.type === 'text') {
    return `<section class="block text-block">${tools}
      ${isEditing
        ? `<textarea class="text-edit" data-field="markdown" data-i="${i}" spellcheck="false">${esc(block.markdown)}</textarea>`
        : `<div class="md">${renderMarkdown(block.markdown) || '<p class="hint">Порожній текстовий блок — натисни ✎</p>'}</div>`}
    </section>`;
  }

  if (block.type === 'figure') {
    const blob = block.imageId && await getImage(block.imageId);
    return `<section class="block figure-block">${tools}
      ${blob ? `<img src="${blobUrl(blob)}" alt="${esc(block.description)}">` : ''}
      ${isEditing
        ? `<textarea class="caption-edit" data-field="description" data-i="${i}">${esc(block.description)}</textarea>`
        : `<p class="caption">🖼 ${esc(block.description)}</p>`}
    </section>`;
  }

  if (block.type === 'qr') {
    const link = /^https?:\/\//i.test(block.value);
    return `<section class="block qr-block">${tools}
      <p>🔳 <strong>${block.format === 'qr_code' ? 'QR-код' : 'Код'}:</strong>
        ${link ? `<a href="${esc(block.value)}" target="_blank" rel="noopener noreferrer">${esc(block.value)}</a>` : esc(block.value)}</p>
    </section>`;
  }

  // Відеослот: оригінальне відео зчитати неможливо, тому тут — власний запис користувача.
  const video = block.videoId && await getVideo(block.videoId);
  const poster = block.posterId && await getImage(block.posterId);
  const posterUrl = poster ? blobUrl(poster) : '';
  const caption = isEditing
    ? `<textarea class="caption-edit" data-field="caption" data-i="${i}" placeholder="Підпис відео">${esc(block.caption)}</textarea>`
    : `<p class="caption">🎬 ${esc(block.caption || 'Відео без підпису')}</p>`;
  return `<section class="block video-block ${video ? '' : 'empty-slot'}">${tools}
    ${video
      ? `<video class="no-print" src="${blobUrl(video)}" controls playsinline preload="metadata"></video>
         ${posterUrl ? `<img class="print-only" src="${posterUrl}" alt="">` : ''}`
      : `<div class="slot">
           ${posterUrl ? `<img src="${posterUrl}" alt="Кадр оригінального відео">` : ''}
           <span class="badge">Потрібен запис</span>
         </div>`}
    ${caption}
    ${block.transcript ? `<p class="transcript">«${esc(block.transcript)}»</p>` : ''}
    <div class="actions no-print">
      <button class="primary" data-action="record" data-i="${i}">⏺ ${video ? 'Перезаписати' : 'Записати своє відео'}</button>
      <label class="secondary">📁 Вибрати файл
        <input type="file" accept="video/*" data-action="upload" data-i="${i}" hidden></label>
      ${video ? `<button class="secondary" data-action="clear-video" data-i="${i}">Прибрати запис</button>` : ''}
      ${video && posterUrl && block.originalPoster ? `<a class="secondary" href="${posterUrl}" target="_blank" rel="noopener">Кадр оригіналу</a>` : ''}
    </div>
  </section>`;
}

async function drawBlocks() {
  const container = document.getElementById('blocks');
  const { blocks } = currentDoc;
  const html = [insertRow(0)];
  for (const [i, block] of blocks.entries()) {
    html.push(await blockHtml(block, i, blocks.length), insertRow(i + 1));
  }
  container.innerHTML = blocks.length ? html.join('') : `<p class="empty">Документ порожній.</p>${insertRow(0)}`;
}

// Зберігає відкриті поля редагування в блоки.
function collectEdits() {
  app.querySelectorAll('#blocks [data-field]').forEach((el) => {
    currentDoc.blocks[Number(el.dataset.i)][el.dataset.field] = el.value;
  });
}

async function onDocClick(e) {
  const btn = e.target.closest('button[data-action], button[data-insert]');
  if (!btn || !currentDoc) return;
  const doc = currentDoc;
  const i = Number(btn.dataset.i);
  const action = btn.dataset.action;

  if (btn.dataset.insert) {
    collectEdits();
    const at = Number(btn.dataset.at);
    const block = btn.dataset.insert === 'text'
      ? { id: newId(), type: 'text', markdown: '' }
      : { id: newId(), type: 'video', caption: '', videoId: null, posterId: null, transcript: '' };
    doc.blocks.splice(at, 0, block);
    editing.add(block.id);
    await saveCurrent();
    await drawBlocks();
    return;
  }

  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText((await loadExport()).documentToText(doc));
      flash('Скопійовано ✓');
    } catch {
      flash('Не вдалося скопіювати');
    }
  } else if (action === 'delete-doc') {
    if (!confirm('Видалити цей документ разом з усіма фото й відео назавжди?')) return;
    await deleteDocument(doc);
    location.hash = '#/';
  } else if (action === 'up' || action === 'down') {
    collectEdits();
    const j = action === 'up' ? i - 1 : i + 1;
    [doc.blocks[i], doc.blocks[j]] = [doc.blocks[j], doc.blocks[i]];
    await saveCurrent();
    await drawBlocks();
  } else if (action === 'edit') {
    editing.add(doc.blocks[i].id);
    await drawBlocks();
    app.querySelector(`#blocks [data-i="${i}"][data-field]`)?.focus();
  } else if (action === 'done') {
    collectEdits();
    editing.delete(doc.blocks[i].id);
    await saveCurrent();
    await renderDocument(doc.id);
    flash('Збережено ✓');
  } else if (action === 'remove') {
    if (!confirm('Видалити цей блок?')) return;
    collectEdits();
    const [block] = doc.blocks.splice(i, 1);
    await saveCurrent();
    await deleteMedia({ imageIds: [block.imageId, block.posterId], videoIds: [block.videoId] });
    await renderDocument(doc.id);
  } else if (action === 'record') {
    collectEdits();
    await openRecorderModal(i);
  } else if (action === 'clear-video') {
    if (!confirm('Прибрати твій запис з цього слоту?')) return;
    const block = doc.blocks[i];
    const old = block.videoId;
    const oldPoster = block.originalPoster ? null : block.posterId;
    block.videoId = null;
    block.transcript = '';
    if (oldPoster) block.posterId = null;
    await saveCurrent();
    await deleteMedia({ imageIds: [oldPoster], videoIds: [old] });
    await renderDocument(doc.id);
  }
}

async function onDocChange(e) {
  const input = e.target.closest('input[data-action="upload"]');
  if (!input || !currentDoc) return;
  const file = input.files?.[0];
  input.value = '';
  if (file) {
    collectEdits();
    await putVideoInSlot(Number(input.dataset.i), file, '');
  }
}

// Кладе відео користувача в слот на місце оригінального.
async function putVideoInSlot(i, blob, transcript) {
  const block = currentDoc.blocks[i];
  const old = block.videoId;
  block.videoId = newId();
  block.transcript = transcript;
  const images = [];
  // Кадр оригінального відео зберігаємо назавжди, а обкладинку власного запису оновлюємо з кожним записом.
  const oldPoster = block.originalPoster ? null : block.posterId;
  if (!block.originalPoster) {
    block.posterId = null;
    try {
      const poster = await posterOf(blob);
      block.posterId = newId();
      images.push({ id: block.posterId, blob: poster });
    } catch {
      // Обкладинка необов'язкова — браузер міг не розпізнати формат для кадру.
    }
  }
  await saveCurrent({ images, videos: [{ id: block.videoId, blob }] });
  await deleteMedia({ imageIds: [oldPoster], videoIds: [old] });
  await renderDocument(currentDoc.id);
  flash('Відео збережено в слоті ✓');
}

async function openRecorderModal(i) {
  const modal = document.getElementById('recorder');
  const block = currentDoc.blocks[i];
  modal.hidden = false;
  modal.innerHTML = `
    <div class="modal-box">
      <h2>Запис у слот${block.caption ? `: ${esc(block.caption)}` : ''}</h2>
      <video id="rec-view" playsinline autoplay muted></video>
      <p id="rec-status" class="status"></p>
      <div class="actions">
        <button id="rec-start" class="primary">⏺ Почати запис</button>
        <button id="rec-stop" class="danger" hidden>⏹ Зупинити</button>
        <button id="rec-save" class="primary" hidden>Зберегти в слот</button>
        <button id="rec-again" class="secondary" hidden>Записати ще раз</button>
        <button id="rec-flip" class="secondary">🔄 Камера</button>
        <button id="rec-cancel" class="secondary">Скасувати</button>
      </div>
    </div>`;

  const view = document.getElementById('rec-view');
  const status = document.getElementById('rec-status');
  const $ = (id) => document.getElementById(id);
  let recorder;
  let result;
  let timer;
  let previewUrl;

  const close = () => {
    clearInterval(timer);
    recorder?.close();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    modal.hidden = true;
    modal.innerHTML = '';
  };
  $('rec-cancel').addEventListener('click', close);

  if (!canRecord()) {
    status.textContent = 'Цей браузер не вміє записувати відео. Скористайся кнопкою «Вибрати файл».';
    ['rec-start', 'rec-flip'].forEach((id) => { $(id).hidden = true; });
    return;
  }
  try {
    recorder = await openRecorder(view);
  } catch (err) {
    console.error(err);
    status.textContent = 'Немає доступу до камери. Дозволь доступ у браузері (потрібен https або localhost) або вибери файл.';
    status.classList.add('error');
    ['rec-start', 'rec-flip'].forEach((id) => { $(id).hidden = true; });
    return;
  }

  const showLive = async () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    view.removeAttribute('src');
    view.controls = false;
    view.muted = true;
    recorder.close();
    recorder = await openRecorder(view);
  };

  $('rec-flip').addEventListener('click', () => recorder.switchCamera().catch(() => {
    status.textContent = 'Іншої камери немає.';
  }));
  $('rec-start').addEventListener('click', () => {
    recorder.start();
    const started = Date.now();
    status.textContent = '● Запис 0:00';
    timer = setInterval(() => { status.textContent = `● Запис ${formatTime((Date.now() - started) / 1000)}`; }, 500);
    $('rec-start').hidden = true;
    $('rec-flip').hidden = true;
    $('rec-stop').hidden = false;
  });
  $('rec-stop').addEventListener('click', async () => {
    clearInterval(timer);
    result = await recorder.stop();
    recorder.close();
    previewUrl = URL.createObjectURL(result.blob);
    view.srcObject = null;
    view.src = previewUrl;
    view.muted = false;
    view.controls = true;
    status.textContent = result.transcript ? `Розшифровка: «${result.transcript}»` : 'Переглянь запис і збережи його.';
    $('rec-stop').hidden = true;
    $('rec-save').hidden = false;
    $('rec-again').hidden = false;
  });
  $('rec-again').addEventListener('click', async () => {
    result = null;
    await showLive();
    status.textContent = '';
    $('rec-save').hidden = true;
    $('rec-again').hidden = true;
    $('rec-start').hidden = false;
    $('rec-flip').hidden = false;
  });
  $('rec-save').addEventListener('click', async () => {
    const { blob, transcript } = result;
    close();
    await putVideoInSlot(i, blob, transcript);
  });
}

app.addEventListener('click', (e) => {
  if (location.hash.startsWith('#/doc/')) onDocClick(e).catch(showError);
});
app.addEventListener('change', (e) => {
  if (location.hash.startsWith('#/doc/')) onDocChange(e).catch(showError);
});

// ---------- Налаштування ----------

function renderSettings() {
  const settings = loadSettings();
  app.innerHTML = `
    ${header('Налаштування', { back: true })}
    <main>
      <form id="settings" class="settings">
        <fieldset>
          <legend>Як розпізнавати</legend>
          <label class="radio"><input type="radio" name="engine" value="claude" ${settings.engine === 'claude' ? 'checked' : ''}>
            <span><strong>Claude</strong> — повне зчитування: текст і рукопис, таблиці, зображення з описами, відео на сторінці,
              розумне зшивання частин. Потрібен інтернет і ключ API.</span></label>
          <label class="radio"><input type="radio" name="engine" value="local" ${settings.engine === 'local' ? 'checked' : ''}>
            <span><strong>Локально</strong> — без ключа, працює офлайн після першого завантаження. Лише текст і QR-коди,
              гірше з рукописом і таблицями.</span></label>
        </fieldset>
        <label class="field">Ключ Claude API
          <input name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.apiKey)}">
        </label>
        <p class="hint">Ключ зберігається лише в цьому браузері на цьому пристрої і надсилається тільки на api.anthropic.com. Створити ключ можна на console.anthropic.com.</p>
        <button class="primary" type="submit">Зберегти</button>
        <p id="saved" class="status"></p>
      </form>
    </main>`;

  document.getElementById('settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const ok = storeSettings({ engine: form.get('engine'), apiKey: String(form.get('apiKey')).trim() });
    document.getElementById('saved').textContent = ok
      ? 'Збережено ✓'
      : 'Не вдалося зберегти: браузер блокує локальне сховище.';
  });
}

// ---------- Маршрутизація ----------

function showError(err) {
  console.error(err);
  app.innerHTML = `${header('Помилка', { back: true })}<main><p class="status error">${esc(err.message)}</p></main>`;
}

async function route() {
  releaseUrls();
  const hash = location.hash.slice(1) || '/';
  const [, page, id] = hash.split('/');
  if (page !== 'doc') currentDoc = null;
  try {
    if (page === 'new') renderNew();
    else if (page === 'doc' && id) await renderDocument(id);
    else if (page === 'settings') renderSettings();
    else await renderLibrary();
  } catch (err) {
    showError(err);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
