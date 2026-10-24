// Відео: вибір чітких неповторюваних кадрів для зчитування і запис власного відео з камери.

import { prepareImage, grayThumb, sharpness, difference } from './image.js';

function once(target, event) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('Не вдалося відкрити відео. Можливо, цей формат не підтримується браузером.'));
    target.addEventListener(event, resolve, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function seek(video, time) {
  return new Promise((resolve) => {
    video.addEventListener('seeked', resolve, { once: true });
    video.currentTime = time;
  });
}

// Відео, записані MediaRecorder, часто не мають тривалості (Infinity) — дізнаємось її, перемотавши в кінець.
async function realDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await seek(video, 1e7);
  const duration = video.currentTime;
  await seek(video, 0);
  return duration;
}

const SCENE_CHANGE = 0.02; // частка змінених пікселів, після якої вважаємо, що в кадрі вже інший вміст

// Повертає масив { blob, time } — найчіткіший кадр з кожного відрізку з однаковим вмістом.
export async function extractFrames(file, { maxFrames = 40, onProgress = () => {} } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata');
    const duration = await realDuration(video);
    const { videoWidth: vw, videoHeight: vh } = video;
    const step = Math.max(0.25, duration / 240);

    const samples = [];
    for (let t = 0; t <= duration; t += step) {
      await seek(video, Math.min(t, Math.max(0, duration - 0.05)));
      const thumb = grayThumb(video, vw, vh);
      samples.push({ thumb, sharp: sharpness(thumb), time: video.currentTime });
      onProgress({ status: `Аналізую відео… ${Math.min(100, Math.round((t / duration) * 100))}%` });
    }

    // Розмиті, змазані й порожні кадри відкидаємо: вони набагато менш чіткі за типовий кадр цього відео.
    const sorted = samples.map((s) => s.sharp).sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
    const clear = samples.filter((s) => s.sharp >= typical * 0.35);

    const groups = [];
    let group = null;
    for (const { thumb, sharp, time } of clear) {
      if (!group || difference(group.ref, thumb) > SCENE_CHANGE) {
        group = { ref: thumb, best: thumb, bestTime: time, bestSharp: sharp };
        groups.push(group);
      } else if (sharp > group.bestSharp) {
        Object.assign(group, { best: thumb, bestTime: time, bestSharp: sharp });
      }
    }

    // Зливаємо сусідні відрізки, чиї найкращі кадри показують той самий вміст.
    const merged = [];
    for (const g of groups) {
      const prev = merged.at(-1);
      if (prev && difference(prev.best, g.best) <= SCENE_CHANGE) {
        if (g.bestSharp > prev.bestSharp) Object.assign(prev, { best: g.best, bestTime: g.bestTime, bestSharp: g.bestSharp });
      } else {
        merged.push({ ...g });
      }
    }

    let chosen = merged;
    if (merged.length > maxFrames) {
      chosen = Array.from({ length: maxFrames }, (_, i) => merged[Math.round((i * (merged.length - 1)) / (maxFrames - 1))]);
    }

    const frames = [];
    for (const [i, g] of chosen.entries()) {
      await seek(video, g.bestTime);
      frames.push({ blob: await prepareImage(video), time: g.bestTime });
      onProgress({ status: `Вибираю кадри… ${i + 1}/${chosen.length}` });
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function formatTime(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Кадр із відео як обкладинка (для відеослотів).
export async function posterOf(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await once(video, 'loadeddata');
    const duration = await realDuration(video);
    await seek(video, Math.min(1, duration / 2));
    return await prepareImage(video, 800);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Запис власного відео ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function canRecord() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

// Камера з попереднім переглядом у videoEl. Під час запису (де браузер уміє) паралельно
// розшифровує мовлення, щоб відео можна було знайти пошуком.
export async function openRecorder(videoEl, { facingMode = 'user' } = {}) {
  let stream;
  let recorder;
  let chunks = [];
  let speech;
  let transcript = '';

  async function startCamera(mode) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode }, audio: true });
    videoEl.srcObject = stream;
    videoEl.muted = true;
    await videoEl.play();
  }
  await startCamera(facingMode);

  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t));

  return {
    async switchCamera() {
      facingMode = facingMode === 'user' ? 'environment' : 'user';
      await startCamera(facingMode);
    },
    start() {
      chunks = [];
      transcript = '';
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
      if (SpeechRecognition) {
        try {
          speech = new SpeechRecognition();
          speech.lang = 'uk-UA';
          speech.continuous = true;
          speech.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
              if (e.results[i].isFinal) transcript += `${e.results[i][0].transcript.trim()} `;
            }
          };
          speech.onerror = () => {};
          speech.start();
        } catch {
          speech = null;
        }
      }
    },
    async stop() {
      // Розшифровка надсилає останні фрази вже після stop() — чекаємо її завершення, але не довше 2 с.
      const speechDone = speech
        ? new Promise((resolve) => {
          speech.onend = resolve;
          setTimeout(resolve, 2000);
          try { speech.stop(); } catch { resolve(); }
        })
        : Promise.resolve();
      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
        recorder.stop();
      });
      await speechDone;
      return { blob, transcript: transcript.trim() };
    },
    close() {
      try { speech?.abort(); } catch { /* розшифровка необов'язкова */ }
      if (recorder?.state === 'recording') recorder.stop();
      stream?.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    },
  };
}
