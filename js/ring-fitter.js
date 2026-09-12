// @ts-ignore
/* global cv */

// ===== 鲁棒环系圆心拟合模块 =====
// 背景: 配准模块旧版 fitRingCenter 用 equalizeHist 增强暗场图, 放大渐晕/噪声 → Hough 检出上百伪圆 →
//       径向振幅匹配锁死在噪声上, 同一张图在不同分辨率下拟出的圆心能差数百像素 (见交接诊断)。
// 本模块改用在主识别流程中验证过的鲁棒管线:
//   ① 背景照度归一化 (除以大核高斯) —— 消除暗场渐晕与曝光不均, 而非放大它
//   ② 粗定位: 霍夫同心圆加权中位数, 失败退回边缘梯度法线投票 (同心圆法线必过圆心, 对伪圆鲁棒)
//   ③ 精修: 极坐标角度不变性 —— 真圆心处每个半径上的环向亮度最均匀 (MAD/中位数最小), 粗到细三级含亚像素
// 仅用于「对齐交叉验证」与「物理圆心标记」, 不再作为对齐主判据 (主判据见 image-registrator 的全局相关)。
// 返回圆心完全由环纹采样统计得出, 不回退到叉丝交点或图像几何中心。

// ---------- 通用工具 ----------
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function oddInt(v) { const n = Math.round(v); return n % 2 === 1 ? n : n + 1; }

function medianOfArray(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function weightedMedian(values, weights) {
  const items = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = items.reduce((s, it) => s + it.w, 0);
  let acc = 0;
  for (const it of items) { acc += it.w; if (acc >= total / 2) return it.v; }
  return items[items.length - 1].v;
}

// 双线性插值采样 (越界返回 -1)
function bilinearSample(data, cols, rows, fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= cols || y1 >= rows) return -1;
  const dx = fx - x0, dy = fy - y0;
  const v00 = data[y0 * cols + x0];
  const v10 = data[y0 * cols + x1];
  const v01 = data[y1 * cols + x0];
  const v11 = data[y1 * cols + x1];
  return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
}

// 移动平均平滑 (忽略 -1 无效值)
function movingAverageValid(arr, window) {
  const n = arr.length;
  const half = Math.floor(window / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) { if (arr[j] >= 0) { sum += arr[j]; cnt++; } }
    out[i] = cnt > 0 ? sum / cnt : -1;
  }
  return out;
}

// 噪声水平估计: 相邻像素差中位数 → 高斯噪声标准差
function estimateNoise(mat) {
  const cols = mat.cols, rows = mat.rows, data = mat.data;
  const samples = [];
  const nSamples = Math.min(20000, cols * rows);
  for (let k = 0; k < nSamples; k++) {
    const x = 1 + Math.floor(Math.random() * (cols - 2));
    const y = 1 + Math.floor(Math.random() * (rows - 1));
    samples.push(Math.abs(data[y * cols + x] - data[y * cols + x + 1]));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] / 0.954;
}

// ---------- ① 背景照度归一化 ----------
// 灰度 → 中值去噪 → 大核背景除照度归一化 → (低对比时 CLAHE, 若构建支持)
// 关键: 用「除以大核高斯背景」替代 equalizeHist, 从根上消除暗场渐晕而不是放大它
export function backgroundNormalize(grayMat) {
  const cols = grayMat.cols, rows = grayMat.rows;
  const denoised = new cv.Mat();
  cv.medianBlur(grayMat, denoised, 3);
  const minDim = Math.min(cols, rows);
  let ksize = Math.round(minDim / 8);
  if (ksize % 2 === 0) ksize += 1;
  ksize = Math.max(ksize, 51);
  const bg = new cv.Mat();
  cv.GaussianBlur(denoised, bg, new cv.Size(ksize, ksize), 0);
  const norm = new cv.Mat(rows, cols, cv.CV_8U);
  const nd = norm.data, dd = denoised.data, bd = bg.data;
  let sum = 0, sumSq = 0;
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    const b = bd[i] > 16 ? bd[i] : 16;
    let v = (dd[i] * 128) / b;
    if (v > 255) v = 255;
    v = Math.round(v);
    nd[i] = v;
    sum += v; sumSq += v * v;
  }
  bg.delete();
  denoised.delete();
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));
  // 整体对比度偏低时才做 CLAHE (本构建可能无 cv.CLAHE, 特性检测后决定, 无则跳过——归一化已足够)
  let out = norm;
  if (std < 45 && typeof cv.CLAHE === 'function') {
    try {
      const enhanced = new cv.Mat();
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      clahe.apply(norm, enhanced);
      clahe.delete();
      norm.delete();
      out = enhanced;
    } catch (e) { /* CLAHE 不可用则保留归一化结果 */ }
  }
  return out;
}

// RGBA/彩色源 → 灰度 (返回新 Mat, 调用方释放)
export function toGrayMat(srcMat) {
  const gray = new cv.Mat();
  if (srcMat.channels() === 1) { srcMat.copyTo(gray); return gray; }
  cv.cvtColor(srcMat, gray, srcMat.channels() === 3 ? cv.COLOR_RGB2GRAY : cv.COLOR_RGBA2GRAY);
  return gray;
}

// ---------- ② 圆心粗定位 ----------
function cornerLimit(mat, cx, cy) {
  const dx = Math.max(cx, mat.cols - 1 - cx);
  const dy = Math.max(cy, mat.rows - 1 - cy);
  return Math.hypot(dx, dy);
}

function coarseCenterByHough(normMat) {
  const cols = normMat.cols, rows = normMat.rows;
  const minDim = Math.min(cols, rows), maxDim = Math.max(cols, rows);
  const blurred = new cv.Mat();
  cv.GaussianBlur(normMat, blurred, new cv.Size(5, 5), 0);
  const circles = new cv.Mat();
  try {
    cv.HoughCircles(
      blurred, circles, cv.HOUGH_GRADIENT,
      1.5, minDim * 0.08, 120, 30,
      Math.round(minDim * 0.05), Math.round(maxDim * 0.75)
    );
  } catch (e) {
    blurred.delete();
    return null;
  }
  const xs = [], ys = [], weights = [];
  const n = circles.cols;
  for (let i = 0; i < n; i++) {
    const cx = circles.data32F[i * 3], cy = circles.data32F[i * 3 + 1], r = circles.data32F[i * 3 + 2];
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
    if (r < minDim * 0.05 || r > maxDim * 0.8) continue;
    xs.push(cx); ys.push(cy); weights.push(n - i);
  }
  circles.delete();
  blurred.delete();
  if (xs.length < 3) return null;
  return { x: weightedMedian(xs, weights), y: weightedMedian(ys, weights) };
}

// 回退: 边缘像素沿梯度法线投票 (同心圆法线必过圆心, 对伪圆/噪声鲁棒)
function coarseCenterByGradientVoting(normMat) {
  const scale = 4;
  const sw = Math.floor(normMat.cols / scale), sh = Math.floor(normMat.rows / scale);
  const small = new cv.Mat(), blurred = new cv.Mat();
  const gx = new cv.Mat(), gy = new cv.Mat();
  try {
    cv.resize(normMat, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(small, blurred, new cv.Size(5, 5), 0);
    cv.Sobel(blurred, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(blurred, gy, cv.CV_32F, 0, 1, 3);
    const acc = new Float32Array(sw * sh);
    const minDim = Math.min(sw, sh);
    const dists = [];
    for (let t = 0.08; t <= 0.73; t += 0.05) dists.push(t * minDim);
    let magSum = 0, magCnt = 0;
    for (let y = 1; y < sh - 1; y += 2) {
      for (let x = 1; x < sw - 1; x += 2) {
        const i = y * sw + x;
        magSum += Math.hypot(gx.data32F[i], gy.data32F[i]); magCnt++;
      }
    }
    const magTh = (magSum / Math.max(magCnt, 1)) * 2;
    for (let y = 1; y < sh - 1; y += 2) {
      for (let x = 1; x < sw - 1; x += 2) {
        const i = y * sw + x;
        const dx = gx.data32F[i], dy = gy.data32F[i];
        const mag = Math.hypot(dx, dy);
        if (mag < magTh) continue;
        const ux = dx / mag, uy = dy / mag;
        for (const t of dists) {
          for (const sign of [1, -1]) {
            const vx = Math.round(x + sign * ux * t), vy = Math.round(y + sign * uy * t);
            if (vx >= 0 && vx < sw && vy >= 0 && vy < sh) acc[vy * sw + vx] += 1;
          }
        }
      }
    }
    let bestI = 0;
    for (let i = 1; i < acc.length; i++) if (acc[i] > acc[bestI]) bestI = i;
    const bx = bestI % sw, by = Math.floor(bestI / sw);
    let sx = 0, sy = 0, sw2 = 0;
    const win = 4;
    for (let dy = -win; dy <= win; dy++) {
      for (let dx = -win; dx <= win; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
        const w = acc[y * sw + x];
        sx += x * w; sy += y * w; sw2 += w;
      }
    }
    return {
      x: sw2 > 0 ? (sx / sw2) * scale : normMat.cols / 2,
      y: sw2 > 0 ? (sy / sw2) * scale : normMat.rows / 2
    };
  } finally {
    small.delete(); blurred.delete(); gx.delete(); gy.delete();
  }
}

function coarseCenter(normMat) {
  return coarseCenterByHough(normMat) || coarseCenterByGradientVoting(normMat);
}

// ---------- ③ 圆心精修: 极坐标角度不变性 ----------
// 正确圆心处每个半径上的环向亮度最均匀 (MAD/中位数最小); 对污点鲁棒, 粗到细三级含亚像素
function centerScore(mat, cx, cy, radii, cosT, sinT) {
  const numAngles = cosT.length;
  const cols = mat.cols, rows = mat.rows, data = mat.data;
  const vals = new Float32Array(numAngles);
  let total = 0, usable = 0;
  for (const r of radii) {
    let count = 0;
    for (let i = 0; i < numAngles; i++) {
      const v = bilinearSample(data, cols, rows, cx + r * cosT[i], cy + r * sinT[i]);
      if (v >= 0) vals[count++] = v;
    }
    if (count < numAngles * 0.3) continue;
    const sorted = Array.from(vals.subarray(0, count)).sort((a, b) => a - b);
    const med = sorted[Math.floor(count / 2)];
    if (med < 4) continue;
    let madSum = 0;
    for (let i = 0; i < count; i++) madSum += Math.abs(sorted[i] - med);
    total += (madSum / count) / med;
    usable++;
  }
  if (usable < radii.length * 0.6) return Infinity;
  return (total / usable) * radii.length;
}

function estimateOuterRadius(normMat, cx, cy, rLimit) {
  const numAngles = 90;
  const maxR = Math.floor(rLimit);
  if (maxR < 5) return Math.max(5, rLimit * 0.8);
  const profile = new Float32Array(maxR + 1);
  for (let r = 2; r <= maxR; r++) {
    let sum = 0, cnt = 0;
    for (let a = 0; a < numAngles; a++) {
      const ang = (a * 2 * Math.PI) / numAngles;
      const v = bilinearSample(normMat.data, normMat.cols, normMat.rows, cx + r * Math.cos(ang), cy + r * Math.sin(ang));
      if (v >= 0) { sum += v; cnt++; }
    }
    profile[r] = cnt >= numAngles * 0.15 ? sum / cnt : -1;
  }
  const sm = movingAverageValid(profile, 5);
  const grads = [];
  for (let r = 3; r < maxR - 1; r++) {
    if (sm[r - 1] >= 0 && sm[r + 1] >= 0) grads.push(Math.abs(sm[r + 1] - sm[r - 1]));
  }
  if (grads.length === 0) return rLimit * 0.8;
  grads.sort((a, b) => a - b);
  const th = grads[Math.floor(grads.length * 0.9)] * 0.15;
  let outer = -1;
  for (let r = maxR - 2; r >= 3; r--) {
    if (sm[r - 1] >= 0 && sm[r + 1] >= 0 && Math.abs(sm[r + 1] - sm[r - 1]) > th) { outer = r; break; }
  }
  if (outer < 0) outer = rLimit * 0.8;
  return Math.min(Math.max(outer, rLimit * 0.3), rLimit);
}

function estimateSaturatedCore(grayMat, cx, cy, outerRadius) {
  const data = grayMat.data, cols = grayMat.cols, rows = grayMat.rows;
  const numRays = 36;
  const maxWalk = Math.min(outerRadius * 0.5, Math.min(cols, rows) * 0.3);
  const runs = [];
  for (let a = 0; a < numRays; a++) {
    const ang = (a * 2 * Math.PI) / numRays;
    let run = 0, gap = 0;
    for (let r = 1; r <= maxWalk; r++) {
      const x = Math.round(cx + r * Math.cos(ang)), y = Math.round(cy + r * Math.sin(ang));
      if (x < 0 || y < 0 || x >= cols || y >= rows) break;
      if (data[y * cols + x] >= 252) { run = r; gap = 0; }
      else { gap++; if (gap > 2) break; }
    }
    runs.push(run);
  }
  runs.sort((a, b) => a - b);
  const med = runs[Math.floor(runs.length / 2)];
  const core = med >= 5 ? med + 3 : 3;
  return Math.min(core, outerRadius * 0.3);
}

function refineCenter(normMat, coarse, innerRadius, outerRadius) {
  const rMin = Math.max(innerRadius + 3, outerRadius * 0.15, 8);
  const rMax = Math.max(rMin + 10, outerRadius * 0.95);
  const nRadii = 24;
  const radii = [];
  for (let i = 0; i < nRadii; i++) radii.push(rMin + ((rMax - rMin) * i) / (nRadii - 1));
  const numAngles = 90;
  const cosT = new Float32Array(numAngles), sinT = new Float32Array(numAngles);
  for (let i = 0; i < numAngles; i++) {
    const a = (i * 2 * Math.PI) / numAngles;
    cosT[i] = Math.cos(a); sinT[i] = Math.sin(a);
  }
  let best = { x: coarse.x, y: coarse.y };
  const levels = [{ range: 60, step: 6 }, { range: 6, step: 1 }, { range: 2, step: 0.25 }];
  for (const lv of levels) {
    let bestScore = Infinity, bestX = best.x, bestY = best.y;
    for (let dy = -lv.range; dy <= lv.range; dy += lv.step) {
      for (let dx = -lv.range; dx <= lv.range; dx += lv.step) {
        const tx = best.x + dx, ty = best.y + dy;
        const s = centerScore(normMat, tx, ty, radii, cosT, sinT);
        if (s < bestScore) { bestScore = s; bestX = tx; bestY = ty; }
      }
    }
    best = { x: bestX, y: bestY };
  }
  return best;
}

// ---------- 对外主入口: 鲁棒环系圆心拟合 ----------
// srcMat: cv.imread 得到的 RGBA/彩色 Mat (调用方持有与释放)
// 返回 { ok, cx, cy, outerRadius, innerRadius, method } 或 { ok:false, message }
export function fitRingCenterRobust(srcMat, label = '') {
  let gray = null, norm = null;
  try {
    gray = toGrayMat(srcMat);
    norm = backgroundNormalize(gray);
    const coarse = coarseCenter(norm);
    let rLimit = cornerLimit(norm, coarse.x, coarse.y);
    let outer0 = estimateOuterRadius(norm, coarse.x, coarse.y, rLimit);
    const inner0 = estimateSaturatedCore(gray, coarse.x, coarse.y, outer0);
    const center = refineCenter(norm, coarse, inner0, Math.min(outer0, rLimit));
    rLimit = cornerLimit(norm, center.x, center.y);
    const outerRadius = estimateOuterRadius(norm, center.x, center.y, rLimit);
    const innerRadius = estimateSaturatedCore(gray, center.x, center.y, outerRadius);
    console.log(`[鲁棒圆心] 图${label} 圆心=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}), 外半径≈${outerRadius.toFixed(1)}px, 过曝核≈${innerRadius.toFixed(1)}px`);
    return { ok: true, cx: center.x, cy: center.y, outerRadius, innerRadius };
  } catch (e) {
    return { ok: false, message: e?.message || '鲁棒圆心拟合异常' };
  } finally {
    gray?.delete?.();
    norm?.delete?.();
  }
}
