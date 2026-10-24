// Експорт документа: Markdown (ZIP з фото і відео), TXT, DOCX. PDF робиться через друк сторінки.

import JSZip from 'jszip';
import { marked } from 'marked';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType,
} from 'docx';
import { getImage, getVideo } from './db.js';

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

function safeName(title) {
  return (title || 'документ').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'документ';
}

function extOf(blob) {
  if (blob.type.includes('mp4')) return 'mp4';
  if (blob.type.includes('quicktime')) return 'mov';
  if (blob.type.includes('webm')) return 'webm';
  if (blob.type.includes('png')) return 'png';
  return 'jpg';
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function metaLines(doc) {
  const lines = [];
  if (doc.folder) lines.push(`Папка: ${doc.folder}`);
  if (doc.tags.length) lines.push(`Теги: ${doc.tags.join(', ')}`);
  return lines;
}

// ---------- Markdown + медіафайли в ZIP ----------

export async function exportMarkdownZip(doc) {
  const zip = new JSZip();
  const parts = [`# ${doc.title}`, ...metaLines(doc).map((l) => `_${l}_`)];
  let fig = 0;
  let vid = 0;
  for (const block of doc.blocks) {
    if (block.type === 'text') {
      parts.push(block.markdown);
    } else if (block.type === 'figure') {
      const blob = block.imageId && await getImage(block.imageId);
      if (blob) {
        const path = `media/image-${++fig}.${extOf(blob)}`;
        zip.file(path, blob);
        parts.push(`![${block.description}](${path})`);
      } else {
        parts.push(`_[Зображення: ${block.description}]_`);
      }
    } else if (block.type === 'video') {
      const blob = block.videoId && await getVideo(block.videoId);
      if (blob) {
        const path = `media/video-${++vid}.${extOf(blob)}`;
        zip.file(path, blob);
        parts.push(`[▶ Відео: ${block.caption || 'без підпису'}](${path})`);
      } else {
        parts.push(`> 🎬 Відео: ${block.caption || 'без підпису'} — запис ще не додано`);
      }
      if (block.transcript) parts.push(`> ${block.transcript}`);
    } else if (block.type === 'qr') {
      parts.push(`QR-код: ${block.value}`);
    }
  }
  zip.file('document.md', `${parts.join('\n\n')}\n`);
  download(await zip.generateAsync({ type: 'blob' }), `${safeName(doc.title)}.zip`);
}

// ---------- TXT ----------

export function documentToText(doc) {
  const parts = [doc.title, ...metaLines(doc)];
  for (const block of doc.blocks) {
    if (block.type === 'text') parts.push(block.markdown);
    else if (block.type === 'figure') parts.push(`[Зображення: ${block.description}]`);
    else if (block.type === 'video') {
      parts.push(`[Відео: ${block.caption || 'без підпису'}${block.videoId ? '' : ' — запис ще не додано'}]`);
      if (block.transcript) parts.push(block.transcript);
    } else if (block.type === 'qr') parts.push(`QR-код: ${block.value}`);
  }
  return parts.join('\n\n');
}

export function exportText(doc) {
  download(new Blob([documentToText(doc)], { type: 'text/plain;charset=utf-8' }), `${safeName(doc.title)}.txt`);
}

// ---------- DOCX ----------

function inlineRuns(tokens = [], style = {}) {
  const runs = [];
  for (const t of tokens) {
    if (t.type === 'strong') runs.push(...inlineRuns(t.tokens, { ...style, bold: true }));
    else if (t.type === 'em') runs.push(...inlineRuns(t.tokens, { ...style, italics: true }));
    else if (t.type === 'del') runs.push(...inlineRuns(t.tokens, { ...style, strike: true }));
    else if (t.type === 'link') runs.push(...inlineRuns(t.tokens, { ...style, underline: {} }));
    else if (t.type === 'br') runs.push(new TextRun({ text: '', break: 1 }));
    else if (t.tokens) runs.push(...inlineRuns(t.tokens, style));
    else runs.push(new TextRun({ ...style, text: decode(t.text ?? t.raw ?? '') }));
  }
  return runs;
}

function decode(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function markdownToDocx(markdown) {
  const out = [];
  const walk = (tokens, quote = false) => {
    for (const t of tokens) {
      if (t.type === 'heading') {
        out.push(new Paragraph({ heading: HEADINGS[t.depth - 1], children: inlineRuns(t.tokens) }));
      } else if (t.type === 'paragraph' || t.type === 'text') {
        out.push(new Paragraph({ children: inlineRuns(t.tokens ?? [t], quote ? { italics: true } : {}) }));
      } else if (t.type === 'list') {
        t.items.forEach((item, i) => {
          const runs = inlineRuns(item.tokens.flatMap((x) => x.tokens ?? [x]));
          out.push(t.ordered
            ? new Paragraph({ children: [new TextRun(`${(t.start || 1) + i}. `), ...runs] })
            : new Paragraph({ bullet: { level: 0 }, children: runs }));
        });
      } else if (t.type === 'blockquote') {
        walk(t.tokens, true);
      } else if (t.type === 'code') {
        t.text.split('\n').forEach((line) => out.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] })));
      } else if (t.type === 'table') {
        const row = (cells, bold) => new TableRow({
          children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: inlineRuns(c.tokens, bold ? { bold: true } : {}) })] })),
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [row(t.header, true), ...t.rows.map((r) => row(r, false))],
        }));
        out.push(new Paragraph(''));
      } else if (t.type === 'hr') {
        out.push(new Paragraph({ text: '—', alignment: 'center' }));
      }
    }
  };
  walk(marked.lexer(markdown, { breaks: true }));
  return out;
}

async function imageRun(blob, maxWidth = 600) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const size = { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) };
  bitmap.close();
  return new ImageRun({ type: 'jpg', data: await blob.arrayBuffer(), transformation: size });
}

export async function exportDocx(doc) {
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(doc.title)] })];
  metaLines(doc).forEach((l) => children.push(new Paragraph({ children: [new TextRun({ text: l, italics: true })] })));

  for (const block of doc.blocks) {
    if (block.type === 'text') {
      children.push(...markdownToDocx(block.markdown));
    } else if (block.type === 'figure') {
      const blob = block.imageId && await getImage(block.imageId);
      if (blob) children.push(new Paragraph({ children: [await imageRun(blob)] }));
      children.push(new Paragraph({ children: [new TextRun({ text: block.description, italics: true })] }));
    } else if (block.type === 'video') {
      const poster = block.posterId && await getImage(block.posterId);
      if (poster) children.push(new Paragraph({ children: [await imageRun(poster, 320)] }));
      const state = block.videoId ? 'файл є в бібліотеці та в експорті Markdown (ZIP)' : 'запис ще не додано';
      children.push(new Paragraph({
        children: [new TextRun({ text: `🎬 Відео: ${block.caption || 'без підпису'} (${state})`, bold: true })],
      }));
      if (block.transcript) children.push(new Paragraph({ children: [new TextRun({ text: block.transcript, italics: true })] }));
    } else if (block.type === 'qr') {
      children.push(new Paragraph({ children: [new TextRun({ text: 'QR-код: ', bold: true }), new TextRun(block.value)] }));
    }
  }

  const file = new Document({ creator: 'Зчитувач', title: doc.title, sections: [{ children }] });
  download(await Packer.toBlob(file), `${safeName(doc.title)}.docx`);
}
