const $ = (id) => document.getElementById(id);

const els = {
  input: $('videoInput'),
  fileName: $('fileName'),
  video: $('video'),
  overlay: $('overlay'),
  viewer: $('viewer'),
  analyzeBtn: $('analyzeBtn'),
  resetBtn: $('resetBtn'),
  status: $('status'),
  distanceInput: $('distanceInput'),
  fpsInput: $('fpsInput'),
  sensitivityInput: $('sensitivityInput'),
  speedResult: $('speedResult'),
  speedDetail: $('speedDetail'),
  pitchResult: $('pitchResult'),
  pitchDetail: $('pitchDetail'),
  frameResult: $('frameResult'),
  breakResult: $('breakResult')
};

let objectUrl = null;
let lastTrack = [];

function setStatus(text) {
  els.status.textContent = text;
}

function resetResults() {
  lastTrack = [];
  els.speedResult.textContent = '-';
  els.speedDetail.textContent = 'km/h';
  els.pitchResult.textContent = '-';
  els.pitchDetail.textContent = '궤적 기반 추정';
  els.frameResult.textContent = '-';
  els.breakResult.textContent = '-';
  clearOverlay();
}

function clearOverlay() {
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function fitOverlayToVideo() {
  const w = els.video.videoWidth || 1280;
  const h = els.video.videoHeight || 720;
  els.overlay.width = w;
  els.overlay.height = h;
}

els.input.addEventListener('change', () => {
  const file = els.input.files?.[0];
  resetResults();
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  els.video.src = objectUrl;
  els.fileName.textContent = file.name;
  els.analyzeBtn.disabled = true;
  setStatus('영상 정보를 불러오는 중입니다.');
});

els.video.addEventListener('loadedmetadata', () => {
  fitOverlayToVideo();
  els.analyzeBtn.disabled = false;
  setStatus(`영상 로드 완료 · ${Math.round(els.video.videoWidth)}×${Math.round(els.video.videoHeight)} · ${els.video.duration.toFixed(2)}초`);
});

els.video.addEventListener('play', () => {
  if (lastTrack.length) drawTrack(lastTrack);
});

els.resetBtn.addEventListener('click', () => {
  resetResults();
  setStatus(els.video.src ? '초기화 완료. 다시 Analyze를 누르면 재분석합니다.' : '영상을 선택하면 분석을 시작할 수 있습니다.');
});

els.analyzeBtn.addEventListener('click', async () => {
  try {
    els.analyzeBtn.disabled = true;
    resetResults();
    fitOverlayToVideo();
    setStatus('프레임을 추출하고 있습니다.');
    const result = await analyzeVideo();
    if (!result.track.length) {
      setStatus('공 궤적을 충분히 찾지 못했습니다. 민감도를 높이거나 투구 구간만 짧게 잘라 다시 시도해 주세요.');
      return;
    }
    lastTrack = result.track;
    drawTrack(result.track);
    renderResult(result);
    setStatus('분석 완료. 결과는 카메라 각도와 프레임레이트에 따라 오차가 있을 수 있습니다.');
  } catch (err) {
    console.error(err);
    setStatus(`분석 중 오류가 발생했습니다: ${err.message || err}`);
  } finally {
    els.analyzeBtn.disabled = !els.video.src;
  }
});

async function analyzeVideo() {
  const video = els.video;
  const distanceM = clamp(Number(els.distanceInput.value) || 18.44, 10, 25);
  const targetFps = clamp(Number(els.fpsInput.value) || 30, 15, 60);
  const sensitivity = Number(els.sensitivityInput.value) || 6;
  const duration = video.duration;
  const nativeW = video.videoWidth;
  const nativeH = video.videoHeight;
  const maxW = 720;
  const scale = Math.min(1, maxW / nativeW);
  const w = Math.round(nativeW * scale);
  const h = Math.round(nativeH * scale);

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true });

  const frameCount = Math.min(Math.floor(duration * targetFps), 220);
  const frames = [];
  const step = duration / Math.max(1, frameCount);

  for (let i = 0; i <= frameCount; i++) {
    const t = Math.min(duration - 0.001, i * step);
    setStatus(`프레임 추출 중 ${i + 1}/${frameCount + 1}`);
    await seekVideo(video, t);
    ctx.drawImage(video, 0, 0, w, h);
    frames.push({ time: t, image: ctx.getImageData(0, 0, w, h) });
  }

  setStatus('움직이는 공 후보를 찾고 있습니다.');
  const candidatesByFrame = [];
  for (let i = 1; i < frames.length; i++) {
    const candidates = findCandidates(frames[i - 1].image, frames[i].image, w, h, sensitivity)
      .map(c => ({ ...c, frameIndex: i, time: frames[i].time, x: c.x / scale, y: c.y / scale, r: c.r / scale }));
    candidatesByFrame.push(candidates);
  }

  setStatus('후보 궤적을 연결하고 있습니다.');
  const track = buildTrack(candidatesByFrame, nativeW, nativeH);
  if (track.length < 4) return { track: [] };

  const first = track[0];
  const last = track[track.length - 1];
  const elapsed = Math.max(0.001, last.time - first.time);
  const speedKmh = (distanceM / elapsed) * 3.6;
  const speedMph = speedKmh / 1.609344;

  const metrics = getTrajectoryMetrics(track);
  const pitch = classifyPitch(speedKmh, metrics);

  return { track, elapsed, speedKmh, speedMph, metrics, pitch };
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('영상 seek 실패'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = Math.min(Math.max(time, 0), Math.max(0, video.duration - 0.001));
  });
}

function findCandidates(prev, curr, w, h, sensitivity) {
  const p = prev.data;
  const c = curr.data;
  const mask = new Uint8Array(w * h);
  const diffThreshold = 78 - sensitivity * 5;
  const minY = Math.floor(h * 0.12);
  const maxY = Math.floor(h * 0.92);

  for (let y = minY; y < maxY; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = (row + x) * 4;
      const dr = Math.abs(c[idx] - p[idx]);
      const dg = Math.abs(c[idx + 1] - p[idx + 1]);
      const db = Math.abs(c[idx + 2] - p[idx + 2]);
      const diff = dr + dg + db;
      const r = c[idx], g = c[idx + 1], b = c[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);
      const ballish = lum > 115 || (lum > 82 && colorSpread < 58);
      if (diff > diffThreshold && ballish) mask[row + x] = 1;
    }
  }

  const seen = new Uint8Array(w * h);
  const out = [];
  const qx = [];
  const qy = [];

  for (let y = minY; y < maxY; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      qx.length = 0; qy.length = 0;
      qx.push(x); qy.push(y); seen[start] = 1;
      let area = 0, sx = 0, sy = 0, maxDiff = 0, maxLum = 0;
      let minX = x, maxX = x, minYY = y, maxYY = y;

      while (head < qx.length) {
        const cx = qx[head];
        const cy = qy[head++];
        const pos = cy * w + cx;
        const idx = pos * 4;
        const diff = Math.abs(c[idx] - p[idx]) + Math.abs(c[idx+1] - p[idx+1]) + Math.abs(c[idx+2] - p[idx+2]);
        const lum = 0.299*c[idx] + 0.587*c[idx+1] + 0.114*c[idx+2];
        area++; sx += cx; sy += cy; maxDiff = Math.max(maxDiff, diff); maxLum = Math.max(maxLum, lum);
        minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minYY = Math.min(minYY, cy); maxYY = Math.max(maxYY, cy);

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= w || ny < minY || ny >= maxY) continue;
            const np = ny * w + nx;
            if (mask[np] && !seen[np]) {
              seen[np] = 1;
              qx.push(nx); qy.push(ny);
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxYY - minYY + 1;
      const longSide = Math.max(bw, bh);
      const shortSide = Math.max(1, Math.min(bw, bh));
      const aspect = longSide / shortSide;
      if (area >= 2 && area <= 260 && longSide <= 34 && aspect <= 6.5) {
        const cx = sx / area;
        const cy = sy / area;
        const score = maxDiff + maxLum * 0.55 - area * 0.8 - Math.max(0, aspect - 2.2) * 12;
        out.push({ x: cx, y: cy, area, r: Math.sqrt(area / Math.PI), score, box: [minX, minYY, maxX, maxYY] });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 26);
}

function buildTrack(candidatesByFrame, videoW, videoH) {
  let tracks = [];
  const maxGap = 3;
  const minMove = Math.max(3, videoW * 0.006);
  const maxMove = Math.max(80, videoW * 0.22);

  candidatesByFrame.forEach((cands) => {
    const nextTracks = [];
    for (const cand of cands) {
      let best = null;
      for (const tr of tracks) {
        const last = tr.points[tr.points.length - 1];
        const gap = cand.frameIndex - last.frameIndex;
        if (gap < 1 || gap > maxGap) continue;
        const dx = cand.x - last.x;
        const dy = cand.y - last.y;
        const d = Math.hypot(dx, dy);
        if (d < minMove || d > maxMove * gap) continue;
        let penalty = Math.abs(d - videoW * 0.045) * 0.18;
        if (tr.points.length >= 2) {
          const prev = tr.points[tr.points.length - 2];
          const vx1 = last.x - prev.x, vy1 = last.y - prev.y;
          const vx2 = cand.x - last.x, vy2 = cand.y - last.y;
          penalty += Math.hypot(vx2 - vx1, vy2 - vy1) * 0.45;
        }
        const progression = Math.abs(cand.x - tr.points[0].x) * 0.05;
        const score = tr.score + cand.score + progression - penalty - (gap - 1) * 18;
        if (!best || score > best.score) best = { tr, score };
      }
      if (best) nextTracks.push({ points: [...best.tr.points, cand], score: best.score });
      nextTracks.push({ points: [cand], score: cand.score });
    }
    tracks = [...tracks, ...nextTracks]
      .sort((a, b) => scoreTrack(b, videoW, videoH) - scoreTrack(a, videoW, videoH))
      .slice(0, 120);
  });

  const viable = tracks
    .filter(t => t.points.length >= 4)
    .sort((a, b) => scoreTrack(b, videoW, videoH) - scoreTrack(a, videoW, videoH));
  return viable[0]?.points || [];
}

function scoreTrack(track, videoW, videoH) {
  const pts = track.points;
  if (!pts.length) return -Infinity;
  const first = pts[0], last = pts[pts.length - 1];
  const span = Math.hypot(last.x - first.x, last.y - first.y);
  const xSpan = Math.abs(last.x - first.x);
  const duration = last.time - first.time;
  let smoothPenalty = 0;
  for (let i = 2; i < pts.length; i++) {
    const ax = pts[i - 1].x - pts[i - 2].x;
    const ay = pts[i - 1].y - pts[i - 2].y;
    const bx = pts[i].x - pts[i - 1].x;
    const by = pts[i].y - pts[i - 1].y;
    smoothPenalty += Math.hypot(bx - ax, by - ay);
  }
  const centerBonus = pts.reduce((sum, p) => {
    const dy = Math.abs(p.y - videoH * 0.52) / videoH;
    return sum + Math.max(0, 1 - dy * 3) * 8;
  }, 0);
  return track.score + pts.length * 90 + span * 1.8 + xSpan * 1.2 + duration * 120 + centerBonus - smoothPenalty * 1.8;
}

function getTrajectoryMetrics(track) {
  const first = track[0];
  const last = track[track.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const samples = track.map((p, i) => ({ ...p, t: i / Math.max(1, track.length - 1) }));
  const expected = samples.map(p => ({ x: first.x + dx * p.t, y: first.y + dy * p.t }));
  let maxVerticalBreak = 0;
  let maxHorizontalBreak = 0;
  samples.forEach((p, i) => {
    maxVerticalBreak = Math.max(maxVerticalBreak, Math.abs(p.y - expected[i].y));
    maxHorizontalBreak = Math.max(maxHorizontalBreak, Math.abs(p.x - expected[i].x));
  });
  return { dx, dy, maxVerticalBreak, maxHorizontalBreak };
}

function classifyPitch(speedKmh, m) {
  const drop = m.dy;
  const vBreak = m.maxVerticalBreak;
  const hBreak = m.maxHorizontalBreak;
  let name = 'Fastball';
  let reason = '빠른 구속과 비교적 직선적인 궤적';

  if (speedKmh < 118 && (drop > 28 || vBreak > 16)) {
    name = 'Curveball';
    reason = '느린 구속과 큰 낙차';
  } else if (speedKmh < 136 && drop > 34) {
    name = 'Splitter / Forkball';
    reason = '중간 구속과 뚜렷한 하강';
  } else if (speedKmh >= 118 && speedKmh <= 146 && hBreak > 20) {
    name = 'Slider / Cutter';
    reason = '중간~빠른 구속과 좌우 변화';
  } else if (speedKmh < 136) {
    name = 'Changeup';
    reason = '패스트볼보다 낮은 구속과 완만한 변화';
  } else if (speedKmh >= 145 && hBreak > 16) {
    name = 'Two-seam / Sinker';
    reason = '빠른 구속과 약간의 좌우·하강 움직임';
  }
  return { name, reason };
}

function drawTrack(track) {
  fitOverlayToVideo();
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!track.length) return;

  ctx.save();
  ctx.lineWidth = Math.max(3, els.overlay.width * 0.005);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 8;

  ctx.beginPath();
  track.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = '#7cc8ff';
  ctx.stroke();

  track.forEach((p, i) => {
    const r = i === 0 || i === track.length - 1 ? 7 : 4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#b9ff9c' : i === track.length - 1 ? '#ffbd7a' : '#ffffff';
    ctx.fill();
  });

  const first = track[0];
  const last = track[track.length - 1];
  ctx.font = `700 ${Math.max(14, els.overlay.width * 0.025)}px system-ui`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Release', first.x + 12, first.y - 12);
  ctx.fillText('Plate side', last.x + 12, last.y - 12);
  ctx.restore();
}

function renderResult(result) {
  const speed = Math.round(result.speedKmh);
  els.speedResult.textContent = `${speed}`;
  els.speedDetail.textContent = `km/h · ${result.speedMph.toFixed(1)} mph · ${result.elapsed.toFixed(3)}s`;
  els.pitchResult.textContent = result.pitch.name;
  els.pitchDetail.textContent = result.pitch.reason;
  els.frameResult.textContent = `${result.track.length}`;
  els.breakResult.textContent = `${Math.round(result.metrics.maxVerticalBreak)} / ${Math.round(result.metrics.maxHorizontalBreak)}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
