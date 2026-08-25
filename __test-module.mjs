// @ts-ignore
/* global Vue, cv */

// ============================================================
// 牛顿环图像处理核心 (两阶段流程)
//   阶段一: detectNewtonRingsCenter  —— 预处理 + 圆心定位 (可人工微调)
//   阶段二: detectRingsWithCenter    —— 按确认的圆心检测暗环
//
// 设计要点:
//   1. 背景除照度归一化, 适配曝光差异 / 背景不均 / 杂散光
//   2. 圆心由周边环形条纹反推 (霍夫圆心加权中位数 + 多半径角度不变性精修),
//      不依赖中心过曝亮斑
//   3. 暗环用多方向径向剖面中位数检测, 条纹周期自动估计, 不硬编码环数
//   4. r²∝m 仅做事后校验, 绝不改写实测半径
// ============================================================

// ===== 阶段一: 圆心定位 =====
async function detectNewtonRingsCenter(
  imageManager,
  showStatus,
  resultImageRef = null
) {
  showStatus('[10%] 正在读取图像...', 'info');
  const src = await loadOriginalImageMat(imageManager);

  let gray = null;
  let prep = null;
  try {
    showStatus('[25%] 预处理: 去噪 + 背景照度归一化...', 'info');
    await raf();
    gray = toGray(src);
    prep = preprocessGray(gray);
    await showDebugImage('背景归一化灰度图', prep.norm, resultImageRef);

    showStatus('[50%] 粗定位圆心 (霍夫圆 / 梯度投票)...', 'info');
    await raf();
    let coarse = coarseCenter(prep.norm);
    console.log(`粗定位圆心: (${coarse.x.toFixed(1)}, ${coarse.y.toFixed(1)})`);

    showStatus('[70%] 多半径角度不变性精修圆心...', 'info');
    await raf();
    let rLimit = cornerLimit(prep.norm, coarse.x, coarse.y);
    let outer0 = estimateOuterRadius(prep.norm, coarse.x, coarse.y, rLimit);
    const inner0 = estimateSaturatedCore(gray, coarse.x, coarse.y, outer0);
    const center = refineCenter(prep.norm, coarse, inner0, Math.min(outer0, rLimit));

    // 用精修后的圆心重新估计外半径与中心过曝区半径 (采样上限到最远角, 兼容偏心裁切)
    rLimit = cornerLimit(prep.norm, center.x, center.y);
    const outerRadius = estimateOuterRadius(prep.norm, center.x, center.y, rLimit);
    const innerRadius = estimateSaturatedCore(gray, center.x, center.y, outerRadius);

    console.log(`精修圆心: (${center.x.toFixed(1)}, ${center.y.toFixed(1)}), 外半径≈${outerRadius.toFixed(1)}px, 中心过曝区≈${innerRadius.toFixed(1)}px`);

    // 调试预览图: 十字 + 外边界
    const dbg = new cv.Mat();
    cv.cvtColor(prep.norm, dbg, cv.COLOR_GRAY2BGR);
    drawCrossOnMat(dbg, center.x, center.y, new cv.Scalar(0, 60, 255, 255));
    const outerColor = new cv.Scalar(0, 200, 255, 255);
    cv.circle(dbg, new cv.Point(center.x, center.y), Math.round(outerRadius), outerColor, 2);
    cv.circle(dbg, new cv.Point(center.x, center.y), Math.round(innerRadius), new cv.Scalar(255, 0, 255, 255), 1);
    await showDebugImage('圆心检测结果(第一阶段)', dbg, resultImageRef);
    dbg.delete();

    showStatus(
      `圆心: (${center.x.toFixed(1)}, ${center.y.toFixed(1)})，外半径≈${outerRadius.toFixed(0)}px`,
      'success'
    );
    return { x: center.x, y: center.y, outerRadius, innerRadius };
  } finally {
    deletePrep(prep);
    gray?.delete?.();
    src?.delete?.();
  }
}

// ===== 阶段二: 按确认的圆心检测暗环 =====
async function detectRingsWithCenter(
  imageManager,
  showStatus,
  center,
  resultImageRef = null
) {
  showStatus('[10%] 正在准备图像...', 'info');
  const src = await loadOriginalImageMat(imageManager);

  let gray = null;
  let prep = null;
  try {
    gray = toGray(src);
    prep = preprocessGray(gray);

    // 以用户确认的圆心重新估计外半径与中心过曝区 (兼容微调后的圆心, 采样上限到最远角)
    const rLimit = cornerLimit(prep.norm, center.x, center.y);
    const outerRadius = estimateOuterRadius(prep.norm, center.x, center.y, rLimit);
    const innerRadius = estimateSaturatedCore(gray, center.x, center.y, outerRadius);
    const usedCenter = { ...center, outerRadius, innerRadius };

    showStatus('[30%] 构建多方向径向剖面...', 'info');
    await raf();
    const rings = detectDarkRingsAdaptive(prep.norm, usedCenter, prep.noiseLevel);

    if (rings.length === 0) {
      throw new Error('未检测到可靠暗环，请微调圆心或更换更清晰的图像后重试');
    }

    showStatus(`[80%] 检测到 ${rings.length} 个暗环，保存结果...`, 'info');
    await raf();
    console.log(`暗环半径: ${rings.map(r => `环${r.number}: ${r.avgRadius.toFixed(1)}`).join(', ')}`);

    imageManager.saveCurrentResultToCache(rings);
    showStatus('[100%] 完成！', 'success');
    return rings;
  } finally {
    deletePrep(prep);
    gray?.delete?.();
    src?.delete?.();
  }
}

// ============================================================
// 预处理
// ============================================================

// 灰度 → 中值去噪 → 大核背景除照度归一化 → (低对比时 CLAHE) → 噪声水平估计
function preprocessGray(grayMat) {
  const cols = grayMat.cols;
  const rows = grayMat.rows;

  // 中值滤波去颗粒噪声
  const denoised = new cv.Mat();
  cv.medianBlur(grayMat, denoised, 3);

  // 大核高斯估计背景照度
  const minDim = Math.min(cols, rows);
  let ksize = Math.round(minDim / 8);
  if (ksize % 2 === 0) ksize += 1;
  ksize = Math.max(ksize, 51);
  const bg = new cv.Mat();
  cv.GaussianBlur(denoised, bg, new cv.Size(ksize, ksize), 0);

  // 除法归一化: norm = denoised / bg * 128 (消除背景不均与杂散光)
  const norm = new cv.Mat(rows, cols, cv.CV_8U);
  const nd = norm.data;
  const dd = denoised.data;
  const bd = bg.data;
  let sum = 0, sumSq = 0;
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    const b = bd[i] > 16 ? bd[i] : 16;
    let v = (dd[i] * 128) / b;
    if (v > 255) v = 255;
    v = Math.round(v);
    nd[i] = v;
    sum += v;
    sumSq += v * v;
  }
  bg.delete();
  denoised.delete();

  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));

  // 整体对比度偏低时才做 CLAHE
  let enhanced = norm;
  if (std < 45) {
    const out = new cv.Mat();
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(norm, out);
    clahe.delete();
    norm.delete();
    enhanced = out;
  }

  const noiseLevel = estimateNoise(enhanced);
  console.log(`预处理: 对比度std=${std.toFixed(1)}, 噪声水平≈${noiseLevel.toFixed(2)}`);
  return { norm: enhanced, noiseLevel, std };
}

function deletePrep(prep) {
  prep?.norm?.delete?.();
}

// 噪声水平估计: 相邻像素差的中位数 → 高斯噪声标准差
function estimateNoise(mat) {
  const cols = mat.cols;
  const rows = mat.rows;
  const data = mat.data;
  const samples = [];
  const nSamples = 20000;
  for (let k = 0; k < nSamples; k++) {
    const x = 1 + Math.floor(Math.random() * (cols - 2));
    const y = 1 + Math.floor(Math.random() * (rows - 1));
    samples.push(Math.abs(data[y * cols + x] - data[y * cols + x + 1]));
  }
  samples.sort((a, b) => a - b);
  const medianDiff = samples[Math.floor(samples.length / 2)];
  // 高斯噪声: E|X1-X2| 的中位数 ≈ 0.954σ
  return medianDiff / 0.954;
}

// ============================================================
// 圆心粗定位
// ============================================================

function coarseCenter(normMat) {
  const hough = coarseCenterByHough(normMat);
  if (hough) return hough;
  console.log('霍夫圆粗定位失败，改用梯度方向投票');
  return coarseCenterByGradientVoting(normMat);
}

// 霍夫圆: 取所有可信同心圆圆心的得分加权中位数 (而非"最大圆")
function coarseCenterByHough(normMat) {
  const cols = normMat.cols;
  const rows = normMat.rows;
  const minDim = Math.min(cols, rows);
  const maxDim = Math.max(cols, rows);

  const blurred = new cv.Mat();
  cv.GaussianBlur(normMat, blurred, new cv.Size(5, 5), 0);

  const circles = new cv.Mat();
  try {
    cv.HoughCircles(
      blurred, circles,
      cv.HOUGH_GRADIENT,
      1.5,                    // dp
      minDim * 0.08,          // minDist
      120,                    // param1 (Canny高阈值)
      30,                     // param2 (累加器阈值)
      Math.round(minDim * 0.05),  // minRadius
      Math.round(maxDim * 0.75)   // maxRadius (偏心时外环半径可超过半幅)
    );
  } catch (e) {
    console.warn('霍夫圆检测异常:', e.message);
    blurred.delete();
    return null;
  }

  const xs = [], ys = [], weights = [];
  const n = circles.cols;
  for (let i = 0; i < n; i++) {
    const cx = circles.data32F[i * 3];
    const cy = circles.data32F[i * 3 + 1];
    const r = circles.data32F[i * 3 + 2];
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
    if (r < minDim * 0.05 || r > maxDim * 0.8) continue;
    xs.push(cx);
    ys.push(cy);
    weights.push(n - i); // 霍夫结果按置信度排序, 越靠前权重越大
  }
  circles.delete();
  blurred.delete();

  if (xs.length < 3) return null;
  const x = weightedMedian(xs, weights);
  const y = weightedMedian(ys, weights);
  console.log(`霍夫圆 ${n} 个, 可信 ${xs.length} 个, 加权中位数圆心(${x.toFixed(1)}, ${y.toFixed(1)})`);
  return { x, y };
}

// 回退方案: 边缘像素沿梯度法线投票 (同心圆的法线必过圆心)
function coarseCenterByGradientVoting(normMat) {
  const scale = 4;
  const sw = Math.floor(normMat.cols / scale);
  const sh = Math.floor(normMat.rows / scale);

  const small = new cv.Mat();
  cv.resize(normMat, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const blurred = new cv.Mat();
  cv.GaussianBlur(small, blurred, new cv.Size(5, 5), 0);
  small.delete();

  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(blurred, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(blurred, gy, cv.CV_32F, 0, 1, 3);
  blurred.delete();

  const acc = new Float32Array(sw * sh);
  const minDim = Math.min(sw, sh);
  // 沿梯度正反两个方向、多个距离上投票 (距离上限放宽, 兼容偏心大环)
  const dists = [];
  for (let t = 0.08; t <= 0.73; t += 0.05) dists.push(t * minDim);

  let magSum = 0, magCnt = 0;
  for (let y = 1; y < sh - 1; y += 2) {
    for (let x = 1; x < sw - 1; x += 2) {
      const i = y * sw + x;
      magSum += Math.hypot(gx.data32F[i], gy.data32F[i]);
      magCnt++;
    }
  }
  const magTh = (magSum / Math.max(magCnt, 1)) * 2;

  for (let y = 1; y < sh - 1; y += 2) {
    for (let x = 1; x < sw - 1; x += 2) {
      const i = y * sw + x;
      const dx = gx.data32F[i];
      const dy = gy.data32F[i];
      const mag = Math.hypot(dx, dy);
      if (mag < magTh) continue;
      const ux = dx / mag, uy = dy / mag;
      for (const t of dists) {
        for (const sign of [1, -1]) {
          const vx = Math.round(x + sign * ux * t);
          const vy = Math.round(y + sign * uy * t);
          if (vx >= 0 && vx < sw && vy >= 0 && vy < sh) {
            acc[vy * sw + vx] += 1;
          }
        }
      }
    }
  }
  gx.delete();
  gy.delete();

  // 找峰值并取邻域加权质心
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
  const cx = sw2 > 0 ? (sx / sw2) * scale : normMat.cols / 2;
  const cy = sw2 > 0 ? (sy / sw2) * scale : normMat.rows / 2;
  console.log(`梯度投票圆心: (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
  return { x: cx, y: cy };
}

function weightedMedian(values, weights) {
  const items = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = items.reduce((s, it) => s + it.w, 0);
  let acc = 0;
  for (const it of items) {
    acc += it.w;
    if (acc >= total / 2) return it.v;
  }
  return items[items.length - 1].v;
}

// ============================================================
// 圆心精修与半径估计
// ============================================================

// 候选圆心到图像边界的最短距离 (仅用于小范围场景, 如过曝核搜索)
function radiusLimit(mat, cx, cy) {
  return Math.max(20, Math.min(cx, cy, mat.cols - 1 - cx, mat.rows - 1 - cy) - 3);
}

// 候选圆心到图像最远角的距离 (径向采样上限, 偏心场景下允许被裁切的外环参与统计)
function cornerLimit(mat, cx, cy) {
  const dx = Math.max(cx, mat.cols - 1 - cx);
  const dy = Math.max(cy, mat.rows - 1 - cy);
  return Math.hypot(dx, dy);
}

// 精修: 极坐标角度不变性 —— 正确圆心处每个半径上的角度方向亮度应最均匀
// 评分 = Σ_r 角度方向的中位数绝对偏差(MAD)/中位数 (MAD 对污点鲁棒)
function refineCenter(normMat, coarse, innerRadius, outerRadius) {
  const rMin = Math.max(innerRadius + 3, outerRadius * 0.15, 8);
  const rMax = Math.max(rMin + 10, outerRadius * 0.95);
  const nRadii = 24;
  const radii = [];
  for (let i = 0; i < nRadii; i++) {
    radii.push(rMin + ((rMax - rMin) * i) / (nRadii - 1));
  }

  const numAngles = 90;
  const cosT = new Float32Array(numAngles);
  const sinT = new Float32Array(numAngles);
  for (let i = 0; i < numAngles; i++) {
    const a = (i * 2 * Math.PI) / numAngles;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a);
  }

  let best = { x: coarse.x, y: coarse.y };
  // 粗到细三级搜索 (最后一级为亚像素; 一级范围放大以补偿偏心时粗定位偏差)
  const levels = [
    { range: 60, step: 6 },
    { range: 6, step: 1 },
    { range: 2, step: 0.25 }
  ];
  for (const lv of levels) {
    let bestScore = Infinity;
    let bestX = best.x, bestY = best.y;
    for (let dy = -lv.range; dy <= lv.range; dy += lv.step) {
      for (let dx = -lv.range; dx <= lv.range; dx += lv.step) {
        const tx = best.x + dx;
        const ty = best.y + dy;
        const s = centerScore(normMat, tx, ty, radii, cosT, sinT);
        if (s < bestScore) {
          bestScore = s;
          bestX = tx;
          bestY = ty;
        }
      }
    }
    best = { x: bestX, y: bestY };
  }
  return best;
}

function centerScore(mat, cx, cy, radii, cosT, sinT) {
  const numAngles = cosT.length;
  const cols = mat.cols, rows = mat.rows;
  const data = mat.data;
  const vals = new Float32Array(numAngles);
  let total = 0;
  let usable = 0;

  for (const r of radii) {
    let count = 0;
    for (let i = 0; i < numAngles; i++) {
      const v = bilinearSample(data, cols, rows, cx + r * cosT[i], cy + r * sinT[i]);
      if (v >= 0) vals[count++] = v;
    }
    // 偏心场景: 覆盖不足的方向跳过该半径 (而非整体判死)
    if (count < numAngles * 0.3) continue;
    // 中位数 + MAD
    const sorted = Array.from(vals.subarray(0, count)).sort((a, b) => a - b);
    const med = sorted[Math.floor(count / 2)];
    if (med < 4) continue;
    let madSum = 0;
    for (let i = 0; i < count; i++) madSum += Math.abs(sorted[i] - med);
    total += (madSum / count) / med;
    usable++;
  }
  // 可用半径过少时整体不可信
  if (usable < radii.length * 0.6) return Infinity;
  // 按可用半径归一化, 避免少半径候选被低估
  return (total / usable) * radii.length;
}

// 外半径: 角度平均径向剖面上最后一个显著梯度位置
function estimateOuterRadius(normMat, cx, cy, rLimit) {
  const numAngles = 90;
  const maxR = Math.floor(rLimit);
  const profile = new Float32Array(maxR + 1);

  for (let r = 2; r <= maxR; r++) {
    let sum = 0, cnt = 0;
    for (let a = 0; a < numAngles; a++) {
      const ang = (a * 2 * Math.PI) / numAngles;
      const v = bilinearSample(
        normMat.data, normMat.cols, normMat.rows,
        cx + r * Math.cos(ang), cy + r * Math.sin(ang)
      );
      if (v >= 0) { sum += v; cnt++; }
    }
    // 偏心时外环只有部分方向可见, 达到最低方向数即参与统计
    profile[r] = cnt >= numAngles * 0.15 ? sum / cnt : -1;
  }

  const sm = movingAverageValid(profile, 5);
  // 梯度绝对值的90分位作为显著性基准
  const grads = [];
  for (let r = 3; r < maxR - 1; r++) {
    if (sm[r - 1] >= 0 && sm[r + 1] >= 0) grads.push(Math.abs(sm[r + 1] - sm[r - 1]));
  }
  if (grads.length === 0) return rLimit * 0.8;
  grads.sort((a, b) => a - b);
  const th = grads[Math.floor(grads.length * 0.9)] * 0.15;

  let outer = -1;
  for (let r = maxR - 2; r >= 3; r--) {
    if (sm[r - 1] >= 0 && sm[r + 1] >= 0 && Math.abs(sm[r + 1] - sm[r - 1]) > th) {
      outer = r;
      break;
    }
  }
  if (outer < 0) outer = rLimit * 0.8;
  return Math.min(Math.max(outer, rLimit * 0.3), rLimit);
}

// 中心过曝区半径: 从圆心沿射线的连续饱和(≥252)段长度 (容忍噪声导致的≤2像素缺口) 的中位数
function estimateSaturatedCore(grayMat, cx, cy, outerRadius) {
  const data = grayMat.data;
  const cols = grayMat.cols, rows = grayMat.rows;
  const numRays = 36;
  const maxWalk = Math.min(outerRadius * 0.5, Math.min(cols, rows) * 0.3);
  const runs = [];

  for (let a = 0; a < numRays; a++) {
    const ang = (a * 2 * Math.PI) / numRays;
    let run = 0;      // 连续饱和段到达的最远距离 (从 r=1 起算)
    let gap = 0;      // 当前连续缺口长度
    for (let r = 1; r <= maxWalk; r++) {
      const x = Math.round(cx + r * Math.cos(ang));
      const y = Math.round(cy + r * Math.sin(ang));
      if (x < 0 || y < 0 || x >= cols || y >= rows) break;
      if (data[y * cols + x] >= 252) {
        run = r;
        gap = 0;
      } else {
        gap++;
        if (gap > 2) break; // 缺口超过2像素, 认为饱和区已结束 (避免误把过曝亮环计入)
      }
    }
    runs.push(run);
  }
  runs.sort((a, b) => a - b);
  const med = runs[Math.floor(runs.length / 2)];
  // 太短说明中心并非饱和亮斑 (或只是零星噪点), 返回最小保留半径; 太长说明全图过曝, 封顶保护
  const core = med >= 5 ? med + 3 : 3;
  return Math.min(core, outerRadius * 0.3);
}

// ============================================================
// 阶段二核心: 自适应暗环检测
// ============================================================

function detectDarkRingsAdaptive(normMat, center, noiseLevel) {
  const cx = center.x, cy = center.y;
  // 采样范围延伸到外半径 (已按最远角封顶), 被裁切的外环由逐半径有效方向数统计支持
  const rMax = center.outerRadius;
  const rStart = Math.max(center.innerRadius + 2, 4);
  if (rMax - rStart < 25) {
    console.warn('可采样径向范围太小, 无法检测暗环');
    return [];
  }

  const dr = 0.5;
  const nR = Math.floor((rMax - rStart) / dr) + 1;
  const numAngles = 180;
  const cosT = new Float32Array(numAngles);
  const sinT = new Float32Array(numAngles);
  for (let i = 0; i < numAngles; i++) {
    const a = (i * 2 * Math.PI) / numAngles;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a);
  }

  // --- 1. 多方向径向剖面 ---
  const data = normMat.data;
  const cols = normMat.cols, rows = normMat.rows;
  const profiles = [];
  for (let a = 0; a < numAngles; a++) {
    const p = new Float32Array(nR);
    for (let i = 0; i < nR; i++) {
      const r = rStart + i * dr;
      p[i] = bilinearSample(data, cols, rows, cx + r * cosT[a], cy + r * sinT[a]);
    }
    profiles.push(p);
  }

  // 每个半径取角度方向中位数 (抗灰尘/污点伪斑); 记录逐半径有效方向数 (偏心时外环只有部分方向可见)
  const med = new Float32Array(nR);
  const validCnt = new Int32Array(nR);
  const tmp = new Float32Array(numAngles);
  const minValid = Math.max(12, Math.round(numAngles * 0.15));
  for (let i = 0; i < nR; i++) {
    let cnt = 0;
    for (let a = 0; a < numAngles; a++) {
      if (profiles[a][i] >= 0) tmp[cnt++] = profiles[a][i];
    }
    validCnt[i] = cnt;
    if (cnt >= minValid) {
      const sorted = Array.from(tmp.subarray(0, cnt)).sort((x, y) => x - y);
      med[i] = sorted[Math.floor(cnt / 2)];
    } else {
      med[i] = -1;
    }
  }

  // --- 2. 自动估计平均条纹周期 (不硬编码环数) ---
  const period0 = estimatePeriod(med, dr);
  if (!period0) {
    console.warn('无法估计条纹周期, 未检测到明暗振荡');
    return [];
  }
  console.log(`估计平均条纹周期: ${period0.toFixed(2)}px`);
  const rMid = rStart + (nR / 2) * dr;
  const perAt = (r) => clamp(period0 * (rMid / r), period0 * 0.4, period0 * 2.5);

  // --- 3. 包络归一化 (消除亮度随半径衰减与曝光差异) ---
  const envWin = oddInt(Math.max(31, Math.round((4 * period0) / dr)));
  const envelope = movingAverageValid(med, envWin);
  const norm = new Float32Array(nR);
  let envMed = medianOfPositive(envelope);
  if (envMed < 8) envMed = 8;
  for (let i = 0; i < nR; i++) {
    const env = envelope[i] > 8 ? envelope[i] : 8;
    norm[i] = med[i] >= 0 ? (med[i] / env) * 100 : -1;
  }

  // --- 4. 平滑 + 自适应突出度阈值找谷底 ---
  const smWin = oddInt(clamp(Math.round(period0 / dr / 2), 5, 25));
  const sm = movingAverageValid(norm, smWin);
  const noiseNorm = Math.max(1.2, (noiseLevel * 100 / envMed) * 1.5);
  const candidates = findMinimaAdaptive(sm, rStart, dr, perAt, noiseNorm);
  console.log(`候选暗环 ${candidates.length} 个: ${candidates.map(c => c.radius.toFixed(1)).join(', ')}`);
  if (candidates.length === 0) return [];

  // --- 5. 逐角度复查 + 质量筛选 ---
  const angSm = profiles.map(p => {
    const pn = new Float32Array(nR);
    for (let i = 0; i < nR; i++) {
      const env = envelope[i] > 8 ? envelope[i] : 8;
      pn[i] = p[i] >= 0 ? (p[i] / env) * 100 : -1;
    }
    return movingAverageValid(pn, smWin);
  });

  const kept = [];
  for (const c of candidates) {
    const per = perAt(c.radius);
    const tol = per / 3;
    const hits = [];
    for (let a = 0; a < numAngles; a++) {
      const hit = searchMinNear(angSm[a], c.radius, rStart, dr, tol);
      if (hit >= 0) hits.push(hit);
    }
    // 出现率按该半径的可见方向数归一化, 裁切环不被冤杀 (要求可见弧≥约90°)
    const iIdx = clamp(Math.round((c.radius - rStart) / dr), 0, nR - 1);
    const visAngles = Math.max(validCnt[iIdx], 1);
    const occ = hits.length / visAngles;
    if (occ < 0.5 || hits.length < 12) continue;
    const medR = medianOfArray(hits);
    const stdR = stdOfArray(hits);
    if (stdR > per * 0.35) continue;
    kept.push({ radius: medR, occurrence: occ, coverage: visAngles / numAngles, std: stdR, prominence: c.prominence });
  }
  console.log(`质量筛选后 ${kept.length} 个暗环 (其中被裁切环 ${kept.filter(k => k.coverage < 0.95).length} 个)`);
  if (kept.length === 0) return [];

  kept.sort((a, b) => a.radius - b.radius);
  // 合并过近的候选
  const merged = [];
  for (const k of kept) {
    const last = merged[merged.length - 1];
    if (last && k.radius - last.radius < perAt(k.radius) * 0.5) {
      if (k.prominence > last.prominence) merged[merged.length - 1] = k;
    } else {
      merged.push(k);
    }
  }

  // --- 6. r²∝m 事后校验 (只标记, 不改半径) ---
  validatePhysics(merged);

  // --- 7. 环数据: 强制同心圆 (弧段补全成整圆, 共用确认圆心, 偏心裁切场景最稳健) ---
  const rings = merged.map(k => ({
    x: cx,
    y: cy,
    avgRadius: k.radius,
    keyPoints: null,
    ellipse: null,
    quality: {
      occurrence: k.occurrence,
      coverage: k.coverage,
      std: k.std,
      suspicious: !!k.suspicious
    }
  }));
  return sortRings(rings);
}

// 从中位数剖面的振荡估计平均条纹周期
function estimatePeriod(med, dr) {
  const n = med.length;
  const trendWin = oddInt(Math.max(31, Math.round(n / 6)));
  const trend = movingAverageValid(med, trendWin);
  const det = new Float32Array(n);
  let sum = 0, sumSq = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    det[i] = med[i] >= 0 && trend[i] >= 0 ? med[i] - trend[i] : 0;
    sum += det[i]; sumSq += det[i] * det[i]; cnt++;
  }
  const std = Math.sqrt(Math.max(0, sumSq / cnt - (sum / cnt) ** 2));
  if (std < 1e-3) return null;

  // 找去趋势剖面的局部极小
  const minimaIdx = [];
  for (let i = 3; i < n - 3; i++) {
    if (det[i] >= 0) continue;
    let isMin = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j !== i && det[j] < det[i]) { isMin = false; break; }
    }
    if (isMin && Math.abs(det[i]) > std * 0.5) minimaIdx.push(i);
  }
  if (minimaIdx.length < 3) return null;

  const spacings = [];
  for (let i = 1; i < minimaIdx.length; i++) {
    const d = (minimaIdx[i] - minimaIdx[i - 1]) * dr;
    if (d >= 4 && d <= (n * dr) / 4) spacings.push(d);
  }
  if (spacings.length < 2) return null;
  return medianOfArray(spacings);
}

// 自适应突出度极小值检测 + 非极大值抑制 + 抛物线亚像素细化
function findMinimaAdaptive(sm, rStart, dr, perAt, noiseNorm) {
  const n = sm.length;
  const minima = [];
  for (let i = 2; i < n - 2; i++) {
    if (sm[i] < 0) continue;
    const r = rStart + i * dr;
    const per = perAt(r);
    const w = Math.max(2, Math.round(per / dr / 3));
    // 局部最小
    let isMin = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (j < 0 || j >= n || sm[j] < 0) { isMin = false; break; }
      if (sm[j] < sm[i]) { isMin = false; break; }
    }
    if (!isMin) continue;

    // 突出度: 两侧各一个周期内的最高点
    const span = Math.max(w, Math.round(per / dr));
    let maxL = -Infinity, maxR = -Infinity;
    for (let j = i - span; j < i; j++) {
      if (j >= 0 && sm[j] >= 0 && sm[j] > maxL) maxL = sm[j];
    }
    for (let j = i + 1; j <= i + span; j++) {
      if (j < n && sm[j] >= 0 && sm[j] > maxR) maxR = sm[j];
    }
    if (!isFinite(maxL) || !isFinite(maxR)) continue;
    const prom = Math.min(maxL, maxR) - sm[i];

    // 局部峰谷摆幅
    let hi = -Infinity, lo = Infinity;
    for (let j = i - span; j <= i + span; j++) {
      if (j >= 0 && j < n && sm[j] >= 0) {
        if (sm[j] > hi) hi = sm[j];
        if (sm[j] < lo) lo = sm[j];
      }
    }
    const swing = hi - lo;
    const threshold = Math.max(2.0 * noiseNorm, 0.18 * swing);
    if (prom <= threshold) continue;

    // 抛物线亚像素细化
    let offset = 0;
    if (i > 0 && i < n - 1 && sm[i - 1] >= 0 && sm[i + 1] >= 0) {
      const denom = sm[i - 1] - 2 * sm[i] + sm[i + 1];
      if (Math.abs(denom) > 1e-6) {
        offset = clamp((0.5 * (sm[i - 1] - sm[i + 1])) / denom, -0.5, 0.5);
      }
    }
    minima.push({ radius: rStart + (i + offset) * dr, prominence: prom });
  }

  // 非极大值抑制: 间距 ≥ 0.6倍局部周期
  minima.sort((a, b) => a.radius - b.radius);
  const result = [];
  for (const m of minima) {
    const last = result[result.length - 1];
    const minDist = perAt(m.radius) * 0.6;
    if (!last || m.radius - last.radius > minDist) {
      result.push(m);
    } else if (m.prominence > last.prominence) {
      result[result.length - 1] = m;
    }
  }
  return result;
}

// 在单条角度剖面上, 于期望半径附近 ±tol 内寻找谷底 (返回亚像素半径, 失败返回-1)
function searchMinNear(profile, expectR, rStart, dr, tol) {
  const n = profile.length;
  const iLo = Math.max(1, Math.floor((expectR - tol - rStart) / dr));
  const iHi = Math.min(n - 2, Math.ceil((expectR + tol - rStart) / dr));
  let bestI = -1;
  for (let i = iLo; i <= iHi; i++) {
    if (profile[i] < 0) continue;
    if (bestI < 0 || profile[i] < profile[bestI]) bestI = i;
  }
  if (bestI < 0) return -1;
  // 抛物线细化
  let offset = 0;
  if (bestI > 0 && bestI < n - 1 && profile[bestI - 1] >= 0 && profile[bestI + 1] >= 0) {
    const denom = profile[bestI - 1] - 2 * profile[bestI] + profile[bestI + 1];
    if (Math.abs(denom) > 1e-6) {
      offset = clamp((0.5 * (profile[bestI - 1] - profile[bestI + 1])) / denom, -0.5, 0.5);
    }
  }
  return rStart + (bestI + offset) * dr;
}

// r²∝m 线性校验: 只标记可疑环, 绝不修改实测半径
function validatePhysics(rings) {
  const n = rings.length;
  if (n < 3) return;
  const r2 = rings.map(k => k.radius * k.radius);
  const ms = rings.map((_, i) => i + 1);
  const sumM = ms.reduce((a, b) => a + b, 0);
  const sumR2 = r2.reduce((a, b) => a + b, 0);
  const sumMR2 = ms.reduce((s, m, i) => s + m * r2[i], 0);
  const sumM2 = ms.reduce((s, m) => s + m * m, 0);
  const denom = n * sumM2 - sumM * sumM;
  if (Math.abs(denom) < 1e-9) return;
  const slope = (n * sumMR2 - sumM * sumR2) / denom;
  const intercept = (sumR2 - slope * sumM) / n;
  console.log(`r²∝m 校验: 斜率=${slope.toFixed(1)}, 截距=${intercept.toFixed(1)}`);
  rings.forEach((k, i) => {
    const expected = slope * (i + 1) + intercept;
    const rel = expected > 0 ? Math.abs(r2[i] - expected) / expected : 1;
    k.suspicious = rel > 0.05;
    if (k.suspicious) {
      console.warn(`环@r=${k.radius.toFixed(1)}: r²偏离线性拟合 ${(rel * 100).toFixed(1)}%, 标记为可疑`);
    }
  });
}

// 排序并顺序编号 (从最内侧起 1,2,3...)
function sortRings(rings) {
  if (!rings || rings.length === 0) return [];
  rings.sort((a, b) => a.avgRadius - b.avgRadius);
  rings.forEach((ring, index) => { ring.number = index + 1; });
  return rings;
}

// ============================================================
// 通用工具
// ============================================================

async function loadOriginalImageMat(imageManager) {
  const url = imageManager.getOriginalImageSrc();
  if (!url) throw new Error('图像未加载');
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('无法加载原始图像'));
    el.src = url;
  });
  return cv.imread(img);
}

function toGray(srcMat) {
  const grayMat = new cv.Mat();
  cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);
  return grayMat;
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
    for (let j = lo; j <= hi; j++) {
      if (arr[j] >= 0) { sum += arr[j]; cnt++; }
    }
    out[i] = cnt > 0 ? sum / cnt : -1;
  }
  return out;
}

function medianOfArray(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function stdOfArray(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function medianOfPositive(arr) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] > 0) vals.push(arr[i]);
  if (vals.length === 0) return 0;
  return medianOfArray(vals);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function oddInt(v) {
  const n = Math.round(v);
  return n % 2 === 1 ? n : n + 1;
}

function raf() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// 在 Mat 上画十字 (调试用)
function drawCrossOnMat(mat, x, y, color) {
  const ix = Math.round(x), iy = Math.round(y);
  cv.circle(mat, new cv.Point(ix, iy), 8, color, 2);
  cv.line(mat, new cv.Point(ix - 40, iy), new cv.Point(ix + 40, iy), color, 1);
  cv.line(mat, new cv.Point(ix, iy - 40), new cv.Point(ix, iy + 40), color, 1);
}

// ===== 调试工具 =====

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 直接改写结果图片显示处理过程 (用于调试)
async function showDebugImage(title, mat, resultImageRef) {
  if (!resultImageRef?.value) return;
  const canvas = document.createElement('canvas');
  cv.imshow(canvas, mat);
  const dataUrl = canvas.toDataURL('image/png');
  canvas.remove();

  resultImageRef.value.src = dataUrl;
  console.log(`🔍 调试: ${title} (${mat.cols}x${mat.rows})`);
  await sleep(300);
}

export { refineCenter, estimateOuterRadius, cornerLimit, detectDarkRingsAdaptive };
