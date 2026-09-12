// @ts-ignore
/* global cv */

import { backgroundNormalize, fitRingCenterRobust } from './ring-fitter.js';

// ===== 像素标定配准模块 =====
// 现役能力 (全自动「一键重叠」级联配准已移除，粗对齐改由用户拖滑块/方向键 + 闪烁对比手动完成):
//   ① refineTranslationNear:    人工粗对齐后的局部小范围精细微调 (多模板 NCC + 修正量一致性验证)
//   ② verifyOverlayOffset:      手动粗对齐质量检查 (只读判定，给出残差与方向建议，不改变偏移)
//   ③ refineTranslationByRings: 基于多环圆心拟合的精细对齐 (环半径全局唯一，免疫局部自相似歧义，叠加对齐首选通路)
// 统一返回结构:
//   { ok, method?, dx?, dy?, message?, detail?, score?, suggestion?, centerA?, centerB? }
// 约定: refine* 返回的 dx, dy 为建议的新绘制偏移 (与传入的 tx, ty 同口径)；
//       内部拟合得到的平移为 B 相对 A (B点 = A点 + d)，绘制偏移 t = −d

// 环系拟合共享阈值: fitRingCenter / fitRingCenterSeeded 直接引用 (逐环圆心相对合成圆心最大允许离散度，像素)
// ①③ 各自的算法参数已改为函数内局部默认值 (不再经由此表)
const DEFAULT_OPTIONS = {
  maxDispersion: 6.0
};

// ---------- 公共工具 ----------
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('配准图像加载失败'));
    img.src = src;
  });
}

function toGrayMat(imgEl) {
  const src = cv.imread(imgEl);
  const gray = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    return gray.clone();
  } finally {
    src.delete();
    gray.delete();
  }
}

// 叉丝候选线检测: 行/列均值剖面邻域反差 + 窄线带宽约束
function findDarkLine(means) {
  const n = means.length;
  const lo = Math.floor(n * 0.3), hi = Math.ceil(n * 0.7);
  const side = Math.max(5, Math.round(n * 0.02));
  let bestIdx = -1, bestContrast = 0;
  for (let i = lo; i < hi; i++) {
    const contrast = Math.min(means[Math.max(0, i - side)], means[Math.min(n - 1, i + side)]) - means[i];
    if (contrast > bestContrast) { bestContrast = contrast; bestIdx = i; }
  }
  if (bestIdx < 0 || bestContrast < 15) return null;
  const th = means[bestIdx] + bestContrast * 0.35;
  let l = bestIdx, r = bestIdx;
  while (l > 0 && means[l - 1] < th) l--;
  while (r < n - 1 && means[r + 1] < th) r++;
  if (r - l + 1 > 8) return null;
  return { pos: bestIdx, half: Math.max(2, Math.ceil((r - l) / 2) + 1) };
}

// 贯穿全图验证: 沿线暗点占比 (排除环纹局部相交误报)
function lineDarkRatio(gray, isVertical, pos) {
  const rows = gray.rows, cols = gray.cols, data = gray.data;
  let dark = 0, counted = 0;
  const len = isVertical ? rows : cols;
  for (let i = 0; i < len; i++) {
    const base = isVertical ? data[i * cols + pos] : data[pos * cols + i];
    // 沿线取邻域比较，跳过整体暗区
    let nb = 0, cnt = 0;
    for (let d = -6; d <= 6; d += 3) {
      const q = pos + d;
      if (isVertical) { if (q >= 0 && q < cols) { nb += data[i * cols + q]; cnt++; } }
      else { if (q >= 0 && q < cols) { nb += data[q * cols + i]; cnt++; } }
    }
    if (!cnt) continue;
    const mean = nb / cnt;
    if (mean < 30) continue;
    counted++;
    if (base < mean * 0.8) dark++;
  }
  return counted > 0 ? dark / counted : 0;
}

// 检测固定十字叉丝，返回 { vLine, hLine } (可能为 null)
function detectCrosshair(gray) {
  const rows = gray.rows, cols = gray.cols, data = gray.data;
  const colSum = new Float64Array(cols);
  const rowSum = new Float64Array(rows);
  for (let y = 0; y < rows; y++) {
    const off = y * cols;
    for (let x = 0; x < cols; x++) {
      const v = data[off + x];
      colSum[x] += v;
      rowSum[y] += v;
    }
  }
  let vLine = findDarkLine(Array.from(colSum, s => s / rows));
  let hLine = findDarkLine(Array.from(rowSum, s => s / cols));
  if (vLine && lineDarkRatio(gray, true, vLine.pos) < 0.7) vLine = null;
  if (hLine && lineDarkRatio(gray, false, hLine.pos) < 0.7) hLine = null;
  return { vLine, hLine };
}

// 判断矩形区域是否与叉丝带相交 (含外扩余量)
function rectHitsCrosshair(x0, y0, x1, y1, vLine, hLine, margin = 4) {
  if (vLine && x0 < vLine.pos + vLine.half + margin && x1 > vLine.pos - vLine.half - margin) return true;
  if (hLine && y0 < hLine.pos + hLine.half + margin && y1 > hLine.pos - hLine.half - margin) return true;
  return false;
}

// 叉丝 inpaint 去除: 两图各自独立修补掉固定十字叉丝, 消除"两图同位置共享人工特征"在全局相关中造成的 d=0 假峰
// (旧 fitRingCenter 也用 inpaint, 此处作用于背景归一化后的 Mat, 供全局相关预处理)
function inpaintCrosshair(mat, vLine, hLine) {
  if (!vLine && !hLine) return;
  const mask = new cv.Mat(mat.rows, mat.cols, cv.CV_8UC1, new cv.Scalar(0));
  const white = new cv.Scalar(255, 255, 255, 255);
  try {
    if (vLine) cv.rectangle(mask, new cv.Point(vLine.pos - vLine.half, 0), new cv.Point(vLine.pos + vLine.half, mat.rows - 1), white, -1);
    if (hLine) cv.rectangle(mask, new cv.Point(0, hLine.pos - hLine.half), new cv.Point(mat.cols - 1, hLine.pos + hLine.half), white, -1);
    const out = new cv.Mat();
    cv.inpaint(mat, mask, out, 3, cv.INPAINT_TELEA);
    out.copyTo(mat);
    out.delete();
  } finally {
    mask.delete();
  }
}

// 相关面峰旁瓣比 PSR: (主峰 − 旁瓣均值) / 旁瓣标准差, 旁瓣 = 主峰 excludeR 邻域外的全部值。
// 真对齐时相关峰尖锐突出 → PSR 高; 纹理不足/伪匹配时峰平坦 → PSR 低。用作"绝不假阳性"的置信闸门。
function psrOfSurface(result, px, py, excludeR = 5) {
  const cols = result.cols, rows = result.rows, data = result.data32F;
  const peak = data[py * cols + px];
  let sum = 0, sumSq = 0, cnt = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (Math.abs(x - px) <= excludeR && Math.abs(y - py) <= excludeR) continue;
      const v = data[y * cols + x];
      sum += v; sumSq += v * v; cnt++;
    }
  }
  if (cnt < 16) return 0;
  const mean = sum / cnt;
  const std = Math.sqrt(Math.max(1e-9, sumSq / cnt - mean * mean));
  return (peak - mean) / std;
}

// 3 点抛物线峰精修: 主峰非边界时用相邻两行/列拟合亚像素偏移，返回浮点峰位或 null (不可精修)
function subpixelPeak(result, px, py) {
  const at = (x, y) => result.data32F[y * result.cols + x];
  if (px <= 0 || py <= 0 || px >= result.cols - 1 || py >= result.rows - 1) return null;
  const vx = at(px, py), lx = at(px - 1, py), rx = at(px + 1, py);
  const vy = at(px, py), ly = at(px, py - 1), ry = at(px, py + 1);
  const dx = (2 * (lx - rx) !== 0) ? (lx - rx) / (2 * (lx - 2 * vx + rx)) : 0;
  const dy = (2 * (ly - ry) !== 0) ? (ly - ry) / (2 * (ly - 2 * vy + ry)) : 0;
  if (!isFinite(dx) || !isFinite(dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  return { x: px + dx, y: py + dy };
}

// 环系圆心粗定位: 直方图均衡增强后霍夫圆检测，取可信同心圆圆心加权中位数 (仅用于模板选位参考)
// 实拍暗场低对比度: 参数经实拍标定 (p2 过严会检出 0；最大半径需覆盖真实外环)
function roughRingCenter(gray) {
  const cols = gray.cols, rows = gray.rows;
  const minDim = Math.min(cols, rows), maxDim = Math.max(cols, rows);
  const enhanced = enhancedMat(gray);
  const circles = new cv.Mat();
  try {
    cv.HoughCircles(
      enhanced, circles, cv.HOUGH_GRADIENT,
      1, minDim * 0.04, 60, 15,
      Math.round(minDim * 0.04), Math.round(maxDim * 0.45)
    );
    const xs = [], ys = [], weights = [];
    for (let i = 0; i < circles.cols; i++) {
      const cx = circles.data32F[i * 3], cy = circles.data32F[i * 3 + 1], r = circles.data32F[i * 3 + 2];
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      if (r < minDim * 0.05 || r > maxDim * 0.8) continue;
      xs.push(cx); ys.push(cy);
      weights.push(circles.cols - i); // 霍夫结果按置信度排序，靠前权重大
    }
    if (xs.length < 3) return null;
    const weightedMedian = (vals) => {
      const items = vals.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
      const total = items.reduce((s, it) => s + it.w, 0);
      let acc = 0;
      for (const it of items) { acc += it.w; if (acc >= total / 2) return it.v; }
      return items[items.length - 1].v;
    };
    return { x: weightedMedian(xs), y: weightedMedian(ys) };
  } catch (e) {
    return null;
  } finally {
    enhanced?.delete?.();
    circles.delete();
  }
}

// 低对比度增强: 直方图均衡 + 高斯平滑 (实拍暗场图环纹反差极弱，不增强 Hough 几乎检不出)
// 注: 本构建无 cv.createCLAHE，equalizeHist 可用
function enhancedMat(gray) {
  const eq = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.equalizeHist(gray, eq);
    cv.GaussianBlur(eq, out, new cv.Size(5, 5), 0);
    return out.clone();
  } finally {
    eq.delete();
    out.delete();
  }
}

// 单图圆环圆心拟合: 预处理去叉丝 → 霍夫多环检测 → 逐环径向对称精修 → 中值合成圆心
// 圆心完全由圆环采样点计算得出，绝不回退到叉丝交点或图像几何中心
function fitRingCenter(src, label) {
  let gray = null, denoised = null, wireMask = null, clean = null, enhanced = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    denoised = new cv.Mat();
    cv.medianBlur(gray, denoised, 3);
    // 叉丝检测与修复 (inpaint 平滑去除叉丝线条，避免其边缘干扰圆拟合)
    const { vLine, hLine } = detectCrosshair(denoised);
    clean = new cv.Mat();
    if (vLine || hLine) {
      wireMask = new cv.Mat(denoised.rows, denoised.cols, cv.CV_8UC1, new cv.Scalar(0));
      const white = new cv.Scalar(255, 255, 255, 255);
      if (vLine) cv.rectangle(wireMask, new cv.Point(vLine.pos - vLine.half, 0), new cv.Point(vLine.pos + vLine.half, denoised.rows - 1), white, -1);
      if (hLine) cv.rectangle(wireMask, new cv.Point(0, hLine.pos - hLine.half), new cv.Point(denoised.cols - 1, hLine.pos + hLine.half), white, -1);
      cv.inpaint(denoised, wireMask, clean, 3, cv.INPAINT_TELEA);
      console.log(`[圆心拟合] 图${label} 叉丝已屏蔽修复:`, vLine ? `竖线 x=${vLine.pos}` : '', hLine ? `横线 y=${hLine.pos}` : '');
    } else {
      denoised.copyTo(clean);
    }
    // 实拍暗场低对比度增强: 直方图均衡后再检圆 (原参数在原图实测检出 0；均衡后可检出上百候选)
    enhanced = enhancedMat(clean);
    // 霍夫圆检测多个同心环 (参数经实拍标定；最大半径需覆盖真实外环，避免检出巨型伪圆)
    const minDim = Math.min(denoised.cols, denoised.rows);
    const circles = new cv.Mat();
    cv.HoughCircles(
      enhanced, circles, cv.HOUGH_GRADIENT,
      1, minDim * 0.04,   // dp, minDist (同心环间距小，需密集检测)
      60, 15,             // param1(Canny), param2(累加器阈值，暗场需放松)
      Math.round(minDim * 0.04), Math.round(minDim * 0.45)
    );
    const raw = [];
    for (let i = 0; i < circles.cols; i++) {
      raw.push({ cx: circles.data32F[i * 3], cy: circles.data32F[i * 3 + 1], r: circles.data32F[i * 3 + 2] });
    }
    circles.delete();
    if (raw.length === 0) return { ok: false, message: '霍夫圆未检测到圆环' };
    // 半径聚类去重: 半径相近的候选归并为同一环 (Hough 对同一环常返回多个近似结果)
    raw.sort((a, b) => a.r - b.r);
    const groups = [];
    for (const c of raw) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(c.r - last.r) < Math.max(4, last.r * 0.04)) continue;
      groups.push({ ...c });
    }
    // 放松阈值后候选数大增 (实拍上百个)，按 Hough 置信序截取前 24 组控制逐环精修开销
    if (groups.length > 24) groups.length = 24;
    // 逐环径向对称性精修圆心 (圆周亮度标准差最小化，跳过叉丝带)
    const wireFree = (x, y) => {
      if (vLine && Math.abs(x - vLine.pos) <= vLine.half) return false;
      if (hLine && Math.abs(y - hLine.pos) <= hLine.half) return false;
      return true;
    };
    // 粗圆心候选: 全部原始候选中值 + 高置信前若干中值 (暗场伪圆多，单一中值可能有偏)，
    // 粗圆心仅为精修初值，最终圆心完全由逐环圆周采样点拟合得出 (多假设宽窗口择优)
    const rawSorted = [...raw]; // raw 已按 Hough 置信序
    const topN = rawSorted.slice(0, Math.min(20, rawSorted.length));
    const hypotheses = [
      { x: median(raw.map(g => g.cx)), y: median(raw.map(g => g.cy)), range: 16, step: 2, tag: '全体中值' },
      { x: median(topN.map(g => g.cx)), y: median(topN.map(g => g.cy)), range: 48, step: 4, tag: '高置信中值' }
    ];
    let rings2 = [];
    let usedHyp = hypotheses[0];
    let bestKey = null; // 择优键: 离散度最小，次选支撑环数最多 (支撑数不能单独作正确性判据)
    for (const hyp of hypotheses) {
      // 首轮粗精修 (宽窗口) → 中值更新 → 窄窗口二轮收敛 (实拍位移可达几十像素)
      const rings = [];
      for (const g of groups) {
        const ref = refineRingCenter(enhanced, hyp.x, hyp.y, g.r, wireFree, hyp.range, hyp.step);
        if (ref) rings.push({ ...ref, r: g.r });
      }
      if (rings.length < 2) continue;
      const cx1 = median(rings.map(p => p.cx));
      const cy1 = median(rings.map(p => p.cy));
      const r2 = [];
      for (const g of groups) {
        const ref = refineRingCenter(enhanced, cx1, cy1, g.r, wireFree, 8);
        if (ref) r2.push({ ...ref, r: g.r });
      }
      if (r2.length < 2) continue;
      const cx2 = median(r2.map(p => p.cx));
      const cy2 = median(r2.map(p => p.cy));
      const sup = r2.filter(p => Math.hypot(p.cx - cx2, p.cy - cy2) <= DEFAULT_OPTIONS.maxDispersion);
      if (sup.length < 2) continue;
      const disp = Math.max(...sup.map(p => Math.hypot(p.cx - cx2, p.cy - cy2)));
      const key = { disp, support: sup.length };
      if (!bestKey || key.disp < bestKey.disp - 0.5 || (Math.abs(key.disp - bestKey.disp) <= 0.5 && key.support > bestKey.support)) {
        bestKey = key;
        rings2 = r2;
        usedHyp = hyp;
      }
    }
    if (rings2.length < 2) return { ok: false, message: `精修后可用圆环不足 (${rings2.length})` };
    const coarseX = usedHyp.x, coarseY = usedHyp.y;
    let cx = median(rings2.map(p => p.cx));
    let cy = median(rings2.map(p => p.cy));
    // 第三轮像素级收敛: 步长1窄窗口，消除步长2的量化误差 (标定精度需求)
    const rings3 = [];
    for (const p of rings2) {
      const ref = refineRingCenter(enhanced, p.cx, p.cy, p.r, wireFree, 3, 1);
      if (ref) rings3.push({ ...ref, r: p.r });
    }
    if (rings3.length >= 2) {
      cx = median(rings3.map(p => p.cx));
      cy = median(rings3.map(p => p.cy));
      rings2.length = 0;
      rings2.push(...rings3);
    }
    // 剔除离群环 (环系外的伪圆精修后偏离合成圆心)，离散度仅由支撑环评估 (中值圆心不受离群影响)
    const supported = rings2.filter(p => Math.hypot(p.cx - cx, p.cy - cy) <= DEFAULT_OPTIONS.maxDispersion);
    if (supported.length < 2) return { ok: false, message: `支撑圆环不足 (${supported.length})` };
    const dispersion = Math.max(...supported.map(p => Math.hypot(p.cx - cx, p.cy - cy)));
    console.log(`[圆心拟合] 图${label} 粗圆心假设=${usedHyp.tag}(${coarseX.toFixed(1)}, ${coarseY.toFixed(1)}), 支撑环 ${supported.length}/${rings2.length} 个, 离散度 ${dispersion.toFixed(2)}px: ` +
      supported.map(p => `r=${p.r.toFixed(0)}@(${p.cx.toFixed(1)},${p.cy.toFixed(1)})`).join(' | '));
    // 强制校验: 圆心必须落在圆环采样数据的支撑范围内 (距逐环圆心最远不超过离散度上限)，
    // 否则说明合成结果并非来自圆环采样 (如退化为几何中心)，判失效交后续算法
    if (dispersion > DEFAULT_OPTIONS.maxDispersion * 2) {
      return { ok: false, message: `圆心离散度过大 (${dispersion.toFixed(1)}px)，采样点不支撑该圆心` };
    }
    return { ok: true, cx, cy, rings: supported, dispersion };
  } finally {
    gray?.delete?.();
    denoised?.delete?.();
    wireMask?.delete?.();
    clean?.delete?.();
    enhanced?.delete?.();
  }
}

// 单环圆心精修: 径向剖面匹配。沿 48 条辐条取径向亮度剖面，环向平均后评估剖面中环带的振幅。
// 圆心正确时所有辐条的环带落在同一径向位置，平均剖面锐利、振幅大；圆心偏移时各辐条环带径向位置不一，
// 平均被抹平、振幅骤降。假半径 (环间空隙) 在任何圆心处剖面都无环带，振幅恒低，被自然排除。
// 注: 不可用"径向 ±2 取梯度极大值"类判据——环间距小时会搭上相邻环，得分面平坦无法定位圆心。
// 最优格点邻域 3 点抛物线亚像素精修: 消除步长量化误差，返回浮点圆心 (标定精度需求)
function refineRingCenter(gray, cx0, cy0, r, wireFree, range = 8, step = 2) {
  const rows = gray.rows, cols = gray.cols;
  const spokes = 48, span = 8;
  const cosT = [], sinT = [];
  for (let i = 0; i < spokes; i++) {
    const ang = (i * 2 * Math.PI) / spokes;
    cosT.push(Math.cos(ang)); sinT.push(Math.sin(ang));
  }
  // 记录最优格点 ±1 邻域振幅 (相对坐标索引 (dx+1)*3+(dy+1))，供抛物线精修；网格不覆盖处保持 null 则不精修
  const localAmp = new Array(9).fill(null);
  let bestX = cx0, bestY = cy0, bestAmp = -1;
  for (let oy = -range; oy <= range; oy += step) {
    for (let ox = -range; ox <= range; ox += step) {
      const tx = cx0 + ox, ty = cy0 + oy;
      const prof = new Float64Array(2 * span + 1);
      let profCnt = 0;
      for (let i = 0; i < spokes; i++) {
        let ok = true;
        const line = new Float64Array(2 * span + 1);
        for (let s = -span; s <= span; s++) {
          const rr = r + s;
          const x = Math.round(tx + rr * cosT[i]), y = Math.round(ty + rr * sinT[i]);
          if (x < 0 || x >= cols || y < 0 || y >= rows || !wireFree(x, y)) { ok = false; break; }
          line[s + span] = gray.ucharAt(y, x);
        }
        if (!ok) continue;
        for (let s = 0; s <= 2 * span; s++) prof[s] += line[s];
        profCnt++;
      }
      if (profCnt < spokes * 0.6) continue; // 可用辐条过少 (靠近边界/叉丝) 则放弃该候选
      // 振幅 = 环带均值与两侧邻带均值之差的较大者 (环可暗可亮)
      let bandSum = 0, innerSum = 0, outerSum = 0;
      for (let s = -span; s <= span; s++) {
        if (s >= -2 && s <= 2) bandSum += prof[s + span];
        else if (s < -2) innerSum += prof[s + span];
        else outerSum += prof[s + span];
      }
      const band = bandSum / 5, inner = innerSum / (span - 2), outer = outerSum / (span - 2);
      const amp = Math.max(Math.abs(band - inner), Math.abs(band - outer));
      if (amp > bestAmp) { bestAmp = amp; bestX = tx; bestY = ty; }
      if (bestX - tx >= -1 && bestX - tx <= 1 && bestY - ty >= -1 && bestY - ty <= 1) {
        localAmp[(bestX - tx + 1) * 3 + (bestY - ty + 1)] = amp;
      }
    }
  }
  // 振幅不足说明该候选半径并非真实干涉环 (剖面无环带结构)，丢弃
  if (bestAmp < 15) return null;
  // 邻域振幅齐全且峰形非平坦时抛物线亚像素精修 (分母为峰值曲率，平坦/噪声面不精修)
  if (localAmp.every(v => v !== null)) {
    const A = (i, j) => localAmp[(i + 1) * 3 + (j + 1)];
    const denX = A(-1, 0) - 2 * A(0, 0) + A(1, 0);
    const denY = A(0, -1) - 2 * A(0, 0) + A(0, 1);
    const fx = denX <= -1e-6 ? (A(-1, 0) - A(1, 0)) / (2 * denX) : 0;
    const fy = denY <= -1e-6 ? (A(0, -1) - A(0, 1)) / (2 * denY) : 0;
    if (Math.abs(fx) <= 0.5 && Math.abs(fy) <= 0.5) return { cx: bestX + fx, cy: bestY + fy };
  }
  return { cx: bestX, cy: bestY };
}

// ---------- ① 人工粗对齐后的局部精细微调 ----------
// 场景: 用户已将图B半透明叠加在图A上并通过滑块/方向键粗对齐 (绘制偏移 tx, ty:
// 图B像素 b 显示在 b + (tx, ty) 处)，本函数仅在当前偏移 ±searchRange 内搜索更优平移，
// 使两套圆环贴合得更好；十字叉丝位于两图相同位置属固定前景，全程排除不参与计算。
// 多模板在各自局部窗口独立匹配 + 修正量一致性验证；结果不可靠时返回 ok=false (上层保持位置不变并提示)
// 返回值的 dx, dy 为建议的新绘制偏移 (与传入的 tx, ty 同口径)
export async function refineTranslationNear(calibImageA, calibImageB, tx, ty, options = {}) {
  const opts = {
    searchRange: 24,           // 单轮各方向搜索半径 (px)
    maxTotalShift: 36,         // 累计修正量上限 (px): 环纹自相似，超出后相邻环伪峰风险剧增，不再扩大搜索 (需求: 只在很小范围内微调)
    templateSizeRatio: 0.18,
    templateCount: 3,
    scoreMin: 0.65,            // 单模板 NCC 得分下限 (粗对齐后重合区得分应明显高于此)
    consistencyThreshold: 2.0, // 多模板修正量最大允许差 (px)
    ...options
  };
  const imgElA = await loadImageEl(calibImageA.src);
  const imgElB = await loadImageEl(calibImageB.src);
  let grayA = null, grayB = null;
  const mats = [];
  try {
    grayA = toGrayMat(imgElA);
    grayB = toGrayMat(imgElB);
    if (grayA.rows !== grayB.rows || grayA.cols !== grayB.cols) {
      return { ok: false, message: '两图尺寸不一致' };
    }
    const rows = grayA.rows, cols = grayA.cols;
    const R = Math.max(8, Math.round(opts.searchRange));
    const { vLine, hLine } = detectCrosshair(grayA);
    const rough = roughRingCenter(grayA) || { x: cols / 2, y: rows / 2 };
    const tSize = Math.max(48, Math.min(220, Math.round(Math.min(cols, rows) * opts.templateSizeRatio)));
    const candidates = pickFineTemplates(grayA, rough, tSize, vLine, hLine, R, opts.templateCount);
    console.log(`[精细对齐] ${candidates.length} 个模板候选, 边长=${tSize}, 搜索半径=±${R}px, 累计上限=${opts.maxTotalShift}px [叉丝: ${vLine ? '竖x=' + vLine.pos : '无'} ${hLine ? '横y=' + hLine.pos : '无'}]`);
    if (!candidates.length) return { ok: false, message: '未找到避开叉丝的合适模板区域，无法精细对齐' };
    // 小范围迭代收敛 (最多两轮，累计修正受 maxTotalShift 封顶):
    // 第一轮峰未触边界 → 直接采信；峰触边界且多模板方向一致 → 按封顶额度续搜一轮，
    // 避免粗对齐偏差略大于单轮半径时直接拒绝；环纹自相似伪峰在较大偏移处不可区分，故不无限扩大搜索范围。
    const searchOnce = (curTx, curTy) => {
      const list = [];
      for (const sel of candidates) {
        const r = matchTemplateNear(grayA, grayB, sel, tSize, curTx, curTy, R, vLine, hLine, mats);
        if (r) list.push(r);
      }
      return list;
    };
    const spreadOf = (list) => {
      let spread = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          spread = Math.max(spread, Math.hypot(list[i].dx - list[j].dx, list[i].dy - list[j].dy));
        }
      }
      return spread;
    };
    let results = searchOnce(tx, ty);
    if (!results.length) return { ok: false, message: '搜索窗口越出图B边界，请先将圆环粗对齐到更靠近的位置' };
    let usable = results.filter(r => r.score >= opts.scoreMin && !r.saturated);
    let roundsUsed = 1;
    if (!usable.length && results.every(r => r.saturated)) {
      // 全部模板峰值触及边界且方向一致 → 还有继续搜索的空间，在累计上限内续搜一轮 (等效扩大搜索半径)
      // 注: 饱和分量已丢失幅度信息 (仅知 ≥R)，方向一致性容差放宽；方向矛盾的伪峰差值达数十像素，仍会被严阈值过滤
      const satTol = opts.consistencyThreshold * 3;
      if (results.length >= 2 && spreadOf(results) > satTol) {
        return { ok: false, message: `多模板微调修正量不一致 (最大差 ${spreadOf(results).toFixed(1)}px > ${satTol}px)，环纹自相似歧义不可靠` };
      }
      let mx = median(results.map(r => r.dx)), my = median(results.map(r => r.dy));   // 饱和峰的中值修正 (方向可信，幅度取下轮验证)
      const mag = Math.hypot(mx, my);
      if (mag > opts.maxTotalShift) {
        // 饱和中值幅度已失真且大偏差下方向可能指向自相似相邻环，不给方向建议 (UI 层提示参考重合度残差粗对齐)
        return { ok: false, message: `粗对齐偏差超过微调范围 (±${opts.maxTotalShift}px)，请先继续拖动滑块把圆环对齐到更靠近的位置` };
      }
      const tx2 = tx + mx, ty2 = ty + my;
      results = searchOnce(tx2, ty2);
      roundsUsed = 2;
      if (!results.length) return { ok: false, message: '搜索窗口越出图B边界，请先将圆环粗对齐到更靠近的位置' };
      usable = results.filter(r => r.score >= opts.scoreMin && !r.saturated);
      if (usable.length) {
        // 第二轮可信修正叠加首轮饱和中值；若仍饱和则说明偏差超出累计上限，拒绝 (防止滑向相邻环伪峰)
        if (usable.length < 2) {
          return { ok: false, message: '第二轮微调可靠模板不足无法交叉验证，结果不可靠，请继续粗对齐后再试' };
        }
        const spread = spreadOf(usable);
        if (spread > opts.consistencyThreshold) {
          return { ok: false, message: `多模板微调修正量不一致 (最大差 ${spread.toFixed(1)}px > ${opts.consistencyThreshold}px)，环纹自相似歧义不可靠` };
        }
        const fx = mx + median(usable.map(r => r.dx)), fy = my + median(usable.map(r => r.dy));
        if (Math.hypot(fx, fy) > opts.maxTotalShift) {
          // 总修正含饱和分量 (幅度失真)，大偏差下方向也可能指向自相似相邻环，不给方向建议
          return { ok: false, message: `粗对齐偏差超过微调范围 (±${opts.maxTotalShift}px)，请先继续拖动滑块把圆环对齐到更靠近的位置` };
        }
        console.log(`[精细对齐] ${roundsUsed} 轮收敛, 总修正 δ(${fx.toFixed(2)}, ${fy.toFixed(2)}) → 绘制偏移 (${(tx + fx).toFixed(1)}, ${(ty + fy).toFixed(1)})`);
        return { ok: true, dx: tx + fx, dy: ty + fy, score: Math.min(...usable.map(r => r.score)), detail: `${roundsUsed}轮迭代, 修正 (${fx.toFixed(1)}, ${fy.toFixed(1)})px` };
      }
      // 大偏差下饱和峰方向可能指向自相似相邻环 (伪峰)，不给方向建议，避免误导手动调整 (UI 层提示参考重合度残差粗对齐)
      return { ok: false, message: `粗对齐偏差超过微调范围 (±${opts.maxTotalShift}px)，请先继续拖动滑块把圆环对齐到更靠近的位置` };
    }
    if (!usable.length) {
      const best = results.reduce((a, b) => (b.score > a.score ? b : a));
      return { ok: false, message: `重叠区纹理匹配得分过低 (${best.score.toFixed(3)} < ${opts.scoreMin})，请重新粗对齐` };
    }
    // 单轮收敛: 多模板修正量一致性验证 (环纹自相似伪匹配在不同模板上修正量彼此矛盾)
    const spread = spreadOf(usable);
    if (usable.length >= 2 && spread > opts.consistencyThreshold) {
      return { ok: false, message: `多模板微调修正量不一致 (最大差 ${spread.toFixed(1)}px > ${opts.consistencyThreshold}px)，环纹自相似歧义不可靠` };
    }
    const dx = median(usable.map(r => r.dx)), dy = median(usable.map(r => r.dy));
    // 饱和模板与可用修正的交叉一致性: 真实平移对所有模板峰位一致；若有模板峰触边界 (声称修正≥R)
    // 而可用修正却小得多，彼此矛盾必为自相似伪峰，拒绝 (宁可提示继续粗对齐，也不把图移偏)
    const satList = results.filter(r => r.saturated);
    if (satList.length) {
      let cross = 0;
      for (const s of satList) cross = Math.max(cross, Math.hypot(s.dx - dx, s.dy - dy));
      if (cross > opts.consistencyThreshold) {
        return { ok: false, message: `部分模板峰值触及搜索边界与其它模板修正矛盾 (差 ${cross.toFixed(1)}px)，环纹自相似歧义不可靠` };
      }
    }
    if (Math.hypot(dx, dy) > opts.maxTotalShift) {
      return { ok: false, suggestion: { dx, dy }, message: `粗对齐偏差超过微调范围 (±${opts.maxTotalShift}px)，请先继续拖动滑块把圆环对齐到更靠近的位置` };
    }
    const minScore = Math.min(...usable.map(r => r.score));
    console.log(`[精细对齐] ${roundsUsed} 轮收敛, ${usable.length}/${results.length} 模板可用, 一致性差 ${spread.toFixed(2)}px, ` +
      `修正 δ(${dx.toFixed(2)}, ${dy.toFixed(2)}) → 绘制偏移 (${(tx + dx).toFixed(1)}, ${(ty + dy).toFixed(1)})`);
    return {
      ok: true,
      dx: tx + dx,
      dy: ty + dy,
      score: minScore,
      detail: `${usable.length}模板, 最低得分 ${minScore.toFixed(3)}, 修正 (${dx.toFixed(1)}, ${dy.toFixed(1)})px${usable.length === 1 ? ' (单模板, 请核对)' : ''}`
    };
  } catch (e) {
    return { ok: false, message: e.message || '精细对齐异常' };
  } finally {
    for (const m of mats) m.delete();
    grayA?.delete?.();
    grayB?.delete?.();
  }
}

// 精细微调模板选位: 策略同粗对齐模板选位，模板自身避开叉丝带，且搜索窗口不越出图边界 (叉丝带由匹配阶段中和处理)
function pickFineTemplates(gray, rough, tSize, vLine, hLine, searchR, count) {
  const rows = gray.rows, cols = gray.cols;
  const data = gray.data;
  const half = tSize / 2;
  const rBase = Math.min(cols, rows);
  const radii = [0.16, 0.24, 0.32].map(f => f * rBase);
  const angles = [0, 45, 90, 135, 180, 225, 270, 315].map(d => d * Math.PI / 180);
  const cands = [];
  for (const r of radii) {
    for (const a of angles) {
      const cx = rough.x + r * Math.cos(a);
      const cy = rough.y + r * Math.sin(a);
      const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
      const x1 = x0 + tSize, y1 = y0 + tSize;
      if (x0 < 2 || y0 < 2 || x1 > cols - 2 || y1 > rows - 2) continue;
      // 搜索窗口在模板四周外扩 searchR，必须完整落在图内 (偏移较大时靠边候选自然淘汰)
      if (x0 - searchR < 1 || y0 - searchR < 1 || x1 + searchR > cols - 1 || y1 + searchR > rows - 1) continue;
      if (rectHitsCrosshair(x0, y0, x1, y1, vLine, hLine, 8)) continue; // 模板本身避开叉丝
      // 区域纹理度 = 像素方差 (隔行采样提速)
      let sum = 0, sumSq = 0, cnt = 0;
      for (let y = y0; y < y1; y += 2) {
        const off = y * cols;
        for (let x = x0; x < x1; x += 2) {
          const v = data[off + x];
          sum += v; sumSq += v * v; cnt++;
        }
      }
      const variance = sumSq / cnt - (sum / cnt) ** 2;
      if (variance < 60) continue;
      cands.push({ x0, y0, variance });
    }
  }
  cands.sort((a, b) => b.variance - a.variance);
  const picked = [];
  const minGap = tSize * 1.2;
  for (const c of cands) {
    if (picked.length >= count) break;
    const ccx = c.x0 + tSize / 2, ccy = c.y0 + tSize / 2;
    if (picked.every(p => Math.hypot(p.x0 + tSize / 2 - ccx, p.y0 + tSize / 2 - ccy) >= minGap)) picked.push(c);
  }
  return picked;
}

// 单模板局部精细搜索: 在图B中围绕期望位置 ±R 窗口内搜索最优修正量 (期望位置 = A模板位置 − 当前绘制偏移)；
// 搜索窗口内的叉丝带用窗口均值填充中和 (固定前景不中和会在 NCC 中制造虚假高分)，中间 Mat 推入 mats 由调用方释放。
// 修正量符号: 峰位偏左(小)说明图B内容实际更靠左，绘制偏移需增大 → δ = R − 峰位
function matchTemplateNear(grayA, grayB, sel, tSize, tx, ty, R, vLine, hLine, mats) {
  const wx0 = sel.x0 - tx - R, wy0 = sel.y0 - ty - R;
  const wSize = tSize + 2 * R;
  if (wx0 < 0 || wy0 < 0 || wx0 + wSize > grayB.cols || wy0 + wSize > grayB.rows) return null;
  const tmpl = grayA.roi(new cv.Rect(sel.x0, sel.y0, tSize, tSize));
  const win = grayB.roi(new cv.Rect(wx0, wy0, wSize, wSize)).clone();
  mats.push(tmpl, win);
  if (vLine || hLine) {
    // 窗口均值 (隔行隔列抽样)
    const d = win.data;
    let sum = 0, cnt = 0;
    for (let y = 0; y < wSize; y += 4) {
      const off = y * wSize;
      for (let x = 0; x < wSize; x += 4) { sum += d[off + x]; cnt++; }
    }
    const mean = sum / cnt;
    const fill = new cv.Scalar(mean, mean, mean, 255);
    const ext = 2; // 叉丝带外扩宽度 (含检测半宽)
    if (vLine) {
      const lx = vLine.pos - wx0;
      cv.rectangle(win, new cv.Point(lx - vLine.half - ext, 0), new cv.Point(lx + vLine.half + ext, wSize - 1), fill, -1);
    }
    if (hLine) {
      const ly = hLine.pos - wy0;
      cv.rectangle(win, new cv.Point(0, ly - hLine.half - ext), new cv.Point(wSize - 1, ly + hLine.half + ext), fill, -1);
    }
  }
  const result = new cv.Mat();
  mats.push(result);
  cv.matchTemplate(win, tmpl, result, cv.TM_CCOEFF_NORMED);
  const mm = cv.minMaxLoc(result);
  const span = 2 * R; // 结果边长 = span + 1，峰位索引范围 [0, span]，触及边缘视为修正量饱和 (需更大搜索范围)
  const saturated = mm.maxLoc.x <= 0 || mm.maxLoc.x >= span || mm.maxLoc.y <= 0 || mm.maxLoc.y >= span;
  let px = mm.maxLoc.x, py = mm.maxLoc.y;
  if (!saturated) {
    const sub = subpixelPeak(result, px, py);
    if (sub) { px = sub.x; py = sub.y; }
  }
  return { score: mm.maxVal, saturated, dx: R - px, dy: R - py };
}

// 指定圆心初值重拟合: 复用 fitRingCenter 的预处理 (去叉丝+增强) 与逐环径向对称精修管线，
// 仅把粗圆心假设替换为外部给定初值 (宽窗口两轮+像素级三轮收敛)。供⑥两阶段拟合对齐两图参考系。
function fitRingCenterSeeded(src, label, seedX, seedY) {
  let gray = null, denoised = null, wireMask = null, clean = null, enhanced = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    denoised = new cv.Mat();
    cv.medianBlur(gray, denoised, 3);
    const { vLine, hLine } = detectCrosshair(denoised);
    clean = new cv.Mat();
    if (vLine || hLine) {
      wireMask = new cv.Mat(denoised.rows, denoised.cols, cv.CV_8UC1, new cv.Scalar(0));
      const white = new cv.Scalar(255, 255, 255, 255);
      if (vLine) cv.rectangle(wireMask, new cv.Point(vLine.pos - vLine.half, 0), new cv.Point(vLine.pos + vLine.half, denoised.rows - 1), white, -1);
      if (hLine) cv.rectangle(wireMask, new cv.Point(0, hLine.pos - hLine.half), new cv.Point(denoised.cols - 1, hLine.pos + hLine.half), white, -1);
      cv.inpaint(denoised, wireMask, clean, 3, cv.INPAINT_TELEA);
    } else {
      denoised.copyTo(clean);
    }
    enhanced = enhancedMat(clean);
    const minDim = Math.min(denoised.cols, denoised.rows);
    const circles = new cv.Mat();
    cv.HoughCircles(
      enhanced, circles, cv.HOUGH_GRADIENT,
      1, minDim * 0.04,
      60, 15,
      Math.round(minDim * 0.04), Math.round(minDim * 0.45)
    );
    const raw = [];
    for (let i = 0; i < circles.cols; i++) {
      raw.push({ cx: circles.data32F[i * 3], cy: circles.data32F[i * 3 + 1], r: circles.data32F[i * 3 + 2] });
    }
    circles.delete();
    if (raw.length === 0) return { ok: false, message: '霍夫圆未检测到圆环' };
    raw.sort((a, b) => a.r - b.r);
    const groups = [];
    for (const c of raw) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(c.r - last.r) < Math.max(4, last.r * 0.04)) continue;
      groups.push({ ...c });
    }
    if (groups.length > 24) groups.length = 24;
    const wireFree = (x, y) => {
      if (vLine && Math.abs(x - vLine.pos) <= vLine.half) return false;
      if (hLine && Math.abs(y - hLine.pos) <= hLine.half) return false;
      return true;
    };
    // 指定初值宽窗口一轮 → 中值更新 → 窄窗口二轮收敛 (与 fitRingCenter 同构)。
    // 种子偏差 = 粗对齐残差，最大 ±36 (与 ⑥ maxTotalShift 一致)，一轮窗口 ±40 需完整覆盖 (步长4控开销)
    const rings = [];
    for (const g of groups) {
      const ref = refineRingCenter(enhanced, seedX, seedY, g.r, wireFree, 40, 4);
      if (ref) rings.push({ ...ref, r: g.r });
    }
    if (rings.length < 2) return { ok: false, message: '指定初值精修后可用圆环不足' };
    const cx1 = median(rings.map(p => p.cx));
    const cy1 = median(rings.map(p => p.cy));
    const r2 = [];
    for (const g of groups) {
      const ref = refineRingCenter(enhanced, cx1, cy1, g.r, wireFree, 12);
      if (ref) r2.push({ ...ref, r: g.r });
    }
    if (r2.length < 2) return { ok: false, message: '指定初值二轮精修后可用圆环不足' };
    let cx = median(r2.map(p => p.cx));
    let cy = median(r2.map(p => p.cy));
    const r3 = [];
    for (const p of r2) {
      const ref = refineRingCenter(enhanced, p.cx, p.cy, p.r, wireFree, 3, 1);
      if (ref) r3.push({ ...ref, r: p.r });
    }
    const ringsFinal = r3.length >= 2 ? r3 : r2;
    if (r3.length >= 2) {
      cx = median(r3.map(p => p.cx));
      cy = median(r3.map(p => p.cy));
    }
    const supported = ringsFinal.filter(p => Math.hypot(p.cx - cx, p.cy - cy) <= DEFAULT_OPTIONS.maxDispersion);
    if (supported.length < 2) return { ok: false, message: `支撑圆环不足 (${supported.length})` };
    const dispersion = Math.max(...supported.map(p => Math.hypot(p.cx - cx, p.cy - cy)));
    console.log(`[圆心拟合] 图${label} 指定初值(${seedX.toFixed(1)}, ${seedY.toFixed(1)}) 支撑环 ${supported.length}/${ringsFinal.length} 个, 离散度 ${dispersion.toFixed(2)}px: ` +
      supported.map(p => `r=${p.r.toFixed(0)}@(${p.cx.toFixed(1)},${p.cy.toFixed(1)})`).join(' | '));
    if (dispersion > DEFAULT_OPTIONS.maxDispersion * 2) {
      return { ok: false, message: `圆心离散度过大 (${dispersion.toFixed(1)}px)` };
    }
    return { ok: true, cx, cy, rings: supported, dispersion };
  } finally {
    gray?.delete?.();
    denoised?.delete?.();
    wireMask?.delete?.();
    clean?.delete?.();
    enhanced?.delete?.();
  }
}

// ---------- ②a 全局平移求解 (相位相关思想的两阶段 NCC，对齐主判据) ----------
// 为什么不用旧圆心拟合: fitRingCenter 在暗场图上会收敛到伪圆盆地 (同图不同分辨率圆心差数百 px)，
// 直接拿它当对齐判据既假阳性又乱给方向。改用整图相关: 牛顿环 r∝√k 间距非均匀，整图相关峰全局唯一，
// 从任意偏移都能直接求出真实平移 (捕获范围 = 图边 − 模板边，可达数百 px)，且免疫伪圆。
// 阶段1: 降采样 + 中心大模板 NCC 全局粗求解 (INTER_AREA 缩图，TM_CCOEFF_NORMED 抗曝光差)；
// 阶段2: 全分辨率多模板 NCC 亚像素精修 (复用 matchTemplateNear 的 ±R 窗口 + 抛物线亚像素)；
// PSR (峰旁瓣比) 作置信闸门: 峰不够尖锐即判不可靠，绝不返回可能被误信的结果。
// 返回 dx, dy 为「理想绘制偏移」(与 overlayDx/overlayDy 同口径，可直接写入或用于求残差)
export async function solveGlobalTranslation(calibImageA, calibImageB, options = {}) {
  const opts = {
    coarseMaxDim: 720,     // 阶段1 降采样长边上限 (提速；相关面峰位换算回全分辨率)
    templateRatio: 0.55,   // 中心模板占短边比例 (捕获范围 = 图边×(1−ratio)，越小范围越大但可靠性降)
    psrMin: 5.0,           // 峰旁瓣比下限 (低于此判纹理不足/不可靠，用真实图可标定微调)
    scoreMin: 0.30,        // NCC 峰得分下限
    refineRange: 10,       // 阶段2 全分辨率亚像素精修窗口半径 (px)
    ...options
  };
  const imgElA = await loadImageEl(calibImageA.src);
  const imgElB = await loadImageEl(calibImageB.src);
  let srcA = null, srcB = null, grayA = null, grayB = null, normA = null, normB = null, smallA = null, smallB = null;
  const mats = [];
  try {
    srcA = cv.imread(imgElA);
    srcB = cv.imread(imgElB);
    if (srcA.rows !== srcB.rows || srcA.cols !== srcB.cols) return { ok: false, message: '两图尺寸不一致' };
    grayA = new cv.Mat(); grayB = new cv.Mat();
    cv.cvtColor(srcA, grayA, srcA.channels() === 3 ? cv.COLOR_RGB2GRAY : cv.COLOR_RGBA2GRAY);
    cv.cvtColor(srcB, grayB, srcB.channels() === 3 ? cv.COLOR_RGB2GRAY : cv.COLOR_RGBA2GRAY);
    // 背景照度归一化 (替代 equalizeHist，消除暗场渐晕而非放大它)
    normA = backgroundNormalize(grayA);
    normB = backgroundNormalize(grayB);
    // 叉丝: 检测后两图各自 inpaint 修补掉，消除"同位置共享人工特征"造成的 d=0 假峰
    const { vLine, hLine } = detectCrosshair(grayA);
    if (vLine || hLine) { inpaintCrosshair(normA, vLine, hLine); inpaintCrosshair(normB, vLine, hLine); }

    // ---- 阶段1: 降采样全局粗求解 ----
    const maxDim = Math.max(normA.rows, normA.cols);
    const scale = Math.min(1, opts.coarseMaxDim / maxDim);
    let fitA = normA, fitB = normB;
    if (scale < 1) {
      const ds = new cv.Size(Math.max(1, Math.round(normA.cols * scale)), Math.max(1, Math.round(normA.rows * scale)));
      smallA = new cv.Mat(); smallB = new cv.Mat();
      cv.resize(normA, smallA, ds, 0, 0, cv.INTER_AREA);
      cv.resize(normB, smallB, ds, 0, 0, cv.INTER_AREA);
      ds.delete?.();
      fitA = smallA; fitB = smallB;
    }
    const tSize = Math.max(48, Math.round(Math.min(fitA.cols, fitA.rows) * opts.templateRatio));
    if (tSize >= fitA.cols || tSize >= fitA.rows) return { ok: false, message: '图像过小，无法做全局相关' };
    const x0 = Math.round((fitA.cols - tSize) / 2), y0 = Math.round((fitA.rows - tSize) / 2);
    const tmpl = fitA.roi(new cv.Rect(x0, y0, tSize, tSize)).clone(); mats.push(tmpl);
    const surf = new cv.Mat(); mats.push(surf);
    cv.matchTemplate(fitB, tmpl, surf, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(surf);
    let px = mm.maxLoc.x, py = mm.maxLoc.y;
    const score = mm.maxVal;
    const psr = psrOfSurface(surf, px, py);
    const sub = subpixelPeak(surf, px, py); if (sub) { px = sub.x; py = sub.y; }
    // 模板左上 (x0,y0) 的 A 特征匹配到 B 的 (px,py): d=(px−x0, py−y0)，绘制偏移 t=−d，换算回全分辨率
    const txCoarse = (x0 - px) / scale, tyCoarse = (y0 - py) / scale;
    console.log(`[全局相关] 粗求解: NCC=${score.toFixed(3)}, PSR=${psr.toFixed(1)}, 模板边=${tSize}, 缩图=${scale.toFixed(2)}x → 偏移(${txCoarse.toFixed(1)}, ${tyCoarse.toFixed(1)})`);
    if (score < opts.scoreMin || psr < opts.psrMin) {
      return { ok: false, score, psr, message: `全局相关置信度不足 (NCC ${score.toFixed(2)} / PSR ${psr.toFixed(1)})，纹理过弱或两图差异过大，无法可靠判定` };
    }

    // ---- 阶段2: 全分辨率亚像素精修 (围绕粗偏移的多模板 NCC 一致性) ----
    let tx = txCoarse, ty = tyCoarse, refined = false, spread = 0, bestScore = score;
    const R = Math.max(4, Math.round(opts.refineRange));
    const tSize2 = Math.max(48, Math.min(220, Math.round(Math.min(normA.cols, normA.rows) * 0.22)));
    const cands = pickFineTemplates(normA, { x: normA.cols / 2, y: normA.rows / 2 }, tSize2, null, null, R, 3);
    const list = [];
    for (const sel of cands) {
      const r = matchTemplateNear(normA, normB, sel, tSize2, txCoarse, tyCoarse, R, null, null, mats);
      if (r) list.push(r);
    }
    if (list.length >= 2) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
        spread = Math.max(spread, Math.hypot(list[i].dx - list[j].dx, list[i].dy - list[j].dy));
      const usable = list.filter(r => r.score >= opts.scoreMin && !r.saturated);
      if (usable.length >= 2 && spread <= 3.0) {
        tx = txCoarse + median(usable.map(r => r.dx));
        ty = tyCoarse + median(usable.map(r => r.dy));
        bestScore = Math.min(...usable.map(r => r.score));
        refined = true;
      }
    }
    console.log(`[全局相关] 精修: ${refined ? `采纳 → 偏移(${tx.toFixed(2)}, ${ty.toFixed(2)})，${list.length}模板一致性差${spread.toFixed(2)}px` : '粗解已足够/精修未采纳 (一致性不足或模板不够)'}`);
    return {
      ok: true, dx: tx, dy: ty, psr, score: bestScore, method: '全局相关', refined,
      detail: `NCC ${bestScore.toFixed(3)}, PSR ${psr.toFixed(1)}${refined ? ', 亚像素精修' : ', 粗解'}${vLine || hLine ? ', 叉丝已修补' : ''}`
    };
  } catch (e) {
    return { ok: false, message: e?.message || '全局相关对齐异常' };
  } finally {
    for (const m of mats) m?.delete?.();
    srcA?.delete?.(); srcB?.delete?.(); grayA?.delete?.(); grayB?.delete?.();
    normA?.delete?.(); normB?.delete?.(); smallA?.delete?.(); smallB?.delete?.();
  }
}

// ---------- ②b 手动粗对齐质量检查 (只读判定，不改变偏移) ----------
// 主判据: 全局相关求出"理想偏移"，残差 = |理想偏移 − 当前偏移| (对齐良好时当前偏移≈理想偏移，残差≈0)。
// PSR 不达标 (全局相关不可靠) 时直接判无法检查，绝不显示可能被误信的残差数字。
// 环系圆心仅作交叉验证 (鲁棒管线): 与相关结果矛盾时附提示，但不否决更可信的相关结果。
// 返回 { ok, dev, dx, dy, psr, centerA?, centerB?, suggestion?, crossWarn?, message? }；
// suggestion = 建议的绘制偏移增量 (理想 − 当前，+Δx=图B右移)，供 UI 给方向提示。
export async function verifyOverlayOffset(calibImageA, calibImageB, tx, ty, options = {}) {
  const g = await solveGlobalTranslation(calibImageA, calibImageB, options);
  if (!g.ok) return { ok: false, message: g.message, psr: g.psr, score: g.score };
  const ex = g.dx - tx, ey = g.dy - ty;   // 需施加的修正量 (理想 − 当前)
  const dev = Math.hypot(ex, ey);
  // 交叉验证: 鲁棒环系圆心 (失败或矛盾都不否决相关主判据，仅提示)
  let centerA = null, centerB = null, crossWarn = '';
  let sA = null, sB = null;
  try {
    const imgElA = await loadImageEl(calibImageA.src);
    const imgElB = await loadImageEl(calibImageB.src);
    sA = cv.imread(imgElA); sB = cv.imread(imgElB);
    const fA = fitRingCenterRobust(sA, 'A');
    const fB = fitRingCenterRobust(sB, 'B');
    if (fA.ok && fB.ok) {
      centerA = { x: fA.cx, y: fA.cy };
      centerB = { x: fB.cx, y: fB.cy };
      // 按理想偏移换算后 B 圆心应落在 A 圆心处: (fB + g.d) − fA ≈ 0
      const cdev = Math.hypot((fB.cx + g.dx) - fA.cx, (fB.cy + g.dy) - fA.cy);
      if (cdev > Math.max(8, dev + 5)) {
        crossWarn = `；⚠️ 环拟合交叉验证偏差 ${cdev.toFixed(1)}px 与相关结果不一致，建议开闪烁对比目视复核`;
      }
    }
  } catch (e) { /* 交叉验证异常不影响主判据 */ }
  finally { sA?.delete?.(); sB?.delete?.(); }
  console.log(`[对齐检查] 理想偏移=(${g.dx.toFixed(1)}, ${g.dy.toFixed(1)}), 当前偏移=(${tx}, ${ty}), 残差=${dev.toFixed(2)}px, PSR=${g.psr?.toFixed(1)}${crossWarn ? ' [交叉验证告警]' : ''}`);
  return {
    ok: true, dev, dx: g.dx, dy: g.dy, psr: g.psr, score: g.score,
    centerA, centerB, detail: g.detail, crossWarn,
    suggestion: dev > 0.5 ? { dx: ex, dy: ey } : null
  };
}
// ---------- ③ 基于多环圆心拟合的精细对齐 (叠加对齐首选通路) ----------
// 原理: 牛顿环半径满足 r_k ∝ √k，每环绝对半径全局唯一 (相邻环仅局部纹理自相似)；
// 两图各自独立拟合多环圆心，用"跨图平移一致性"聚类匹配环序对，圆心差即平移量。
// 与 ① 局部模板搜索互补: 整圈采样免疫局部纹理歧义，粗对齐偏差较大也能直接给出结果；
// 但仍尊重"精细对齐只在小范围微调"的需求: 拟合结果与当前偏移相差超限时拒绝。
// 返回的 dx, dy 为建议新绘制偏移 (浮点亚像素，与传入的 tx, ty 同口径)
export async function refineTranslationByRings(calibImageA, calibImageB, tx, ty, options = {}) {
  const opts = {
    minRings: 4,               // 最少一致匹配环对数 (环序匹配需足够支撑)
    ringRadiusTol: 0.04,       // 环序半径匹配容差 (占半径比例，下限 2px)
    consistencyThreshold: 2.0, // 逐环平移偏差最大允许差 (px)
    maxDispersion: 6.0,        // 单图拟合逐环圆心离散度上限 (px)
    maxTotalShift: 36,         // 拟合结果与当前偏移差值上限 (px): 精细对齐只在小范围内微调
    ...options
  };
  const imgElA = await loadImageEl(calibImageA.src);
  const imgElB = await loadImageEl(calibImageB.src);
  let srcA = null, srcB = null;
  try {
    srcA = cv.imread(imgElA);
    srcB = cv.imread(imgElB);
    if (srcA.rows !== srcB.rows || srcA.cols !== srcB.cols) {
      return { ok: false, message: '两图尺寸不一致' };
    }
    const fitA = fitRingCenter(srcA, 'A');
    if (!fitA.ok) return { ok: false, message: `图A圆环拟合失败 (${fitA.message})` };
    // 图B拟合以"图A圆心按当前偏移反推"为种子: 粗对齐后两环系已接近重合，图B真圆心应在 cA − t 附近 (残差=粗对齐误差，
    // 在精修收敛窗内)。独立拟合的粗圆心初值可能落入伪圆盆地 (暗场自相似)，种子化可避免两图参考系错位。
    // 种子仅指导拟合初值，结果仍由半径匹配+逐环平移一致性独立验证，种子偏差时自然被拒。
    let fitB = fitRingCenterSeeded(srcB, 'B', fitA.cx - tx, fitA.cy - ty);
    if (!fitB.ok) {
      console.log(`[精细对齐/环拟合] 图B种子化重拟合失败 (${fitB.message})，改用独立拟合`);
      fitB = fitRingCenter(srcB, 'B');
    }
    if (!fitB.ok) return { ok: false, message: `图B圆环拟合失败 (${fitB.message})` };
    if (fitA.rings.length < 3 || fitB.rings.length < 3) {
      return { ok: false, message: `可用圆环不足 (${fitA.rings.length}/${fitB.rings.length})` };
    }
    if (Math.max(fitA.dispersion, fitB.dispersion) > opts.maxDispersion) {
      return { ok: false, message: `圆心离散度过大 (${fitA.dispersion.toFixed(2)}/${fitB.dispersion.toFixed(2)}px)，拟合质量不足` };
    }
    // 环序匹配: 半径相近的环组成候选对，再用平移一致性聚类 (真实平移对全部同序环一致，
    // 错序伪对 (相邻环自相似) 的平移彼此矛盾被淘汰)。确定性两轮中值共识 (无随机抽样，结果可复现):
    // 先全对中值估基准平移，剔除偏差对后再中值合成，错序伪对偏移大 (> 环间距) 首轮即出局
    const pairs = [];
    for (const ra of fitA.rings) {
      for (const rb of fitB.rings) {
        if (Math.abs(ra.r - rb.r) <= Math.max(2, Math.min(ra.r, rb.r) * opts.ringRadiusTol)) {
          pairs.push({ ax: ra.cx, ay: ra.cy, bx: rb.cx, by: rb.cy });
        }
      }
    }
    if (!pairs.length) {
      console.log(`[精细对齐/环拟合] 半径不匹配: A支撑环 [${fitA.rings.map(p => p.r.toFixed(0)).join(',')}], B支撑环 [${fitB.rings.map(p => p.r.toFixed(0)).join(',')}]`);
      return { ok: false, message: '未找到半径匹配的环对 (两图环系差异过大)' };
    }
    const mx0 = median(pairs.map(p => p.bx - p.ax));
    const my0 = median(pairs.map(p => p.by - p.ay));
    const inliers = pairs.filter(p =>
      Math.abs((p.bx - p.ax) - mx0) <= opts.consistencyThreshold &&
      Math.abs((p.by - p.ay) - my0) <= opts.consistencyThreshold);
    if (inliers.length < opts.minRings) {
      return { ok: false, message: `一致匹配的圆环不足 (${inliers.length} < ${opts.minRings})，环序匹配歧义` };
    }
    // 中值合成平移并复核一致性 (从严验证)
    const dxB = median(inliers.map(p => p.bx - p.ax));
    const dyB = median(inliers.map(p => p.by - p.ay));
    let spread = 0;
    for (const p of inliers) spread = Math.max(spread, Math.hypot((p.bx - p.ax) - dxB, (p.by - p.ay) - dyB));
    if (spread > opts.consistencyThreshold) {
      return { ok: false, message: `逐环平移偏差超限 (最大 ${spread.toFixed(2)}px)，环序匹配不可靠` };
    }
    // B相对A平移 d = (dxB, dyB)；绘制偏移 t = −d (图B像素 b 显示在 b + t 处)
    const tNewX = -dxB, tNewY = -dyB;
    const dev = Math.hypot(tNewX - tx, tNewY - ty);
    if (dev > opts.maxTotalShift) {
      // 拟合目标明确，附带手动粗对齐方向建议 (修正量 = 目标偏移 − 当前偏移，幅度可信)
      return { ok: false, suggestion: { dx: tNewX - tx, dy: tNewY - ty }, message: `粗对齐偏差超过微调范围 (拟合结果与当前偏移差 ${dev.toFixed(1)}px > ±${opts.maxTotalShift}px)，请先继续拖动滑块把圆环对齐到更靠近的位置` };
    }
    console.log(`[精细对齐/环拟合] 匹配 ${inliers.length}/${pairs.length} 对, 偏差 ${spread.toFixed(2)}px, ` +
      `d=(${dxB.toFixed(2)}, ${dyB.toFixed(2)}) → 绘制偏移 (${tNewX.toFixed(2)}, ${tNewY.toFixed(2)}) [当前 (${tx.toFixed(1)}, ${ty.toFixed(1)})]`);
    return {
      ok: true,
      method: '圆心拟合',
      dx: tNewX, dy: tNewY,
      detail: `${inliers.length}环匹配, 偏差 ${spread.toFixed(2)}px, 离散度 ${Math.max(fitA.dispersion, fitB.dispersion).toFixed(2)}px`,
      centerA: { x: fitA.cx, y: fitA.cy },
      centerB: { x: fitB.cx, y: fitB.cy }
    };
  } catch (e) {
    return { ok: false, message: e.message || '环拟合精细对齐异常' };
  } finally {
    srcA?.delete?.();
    srcB?.delete?.();
  }
}

// ---------- ④ 浏览器控制台自检 (验收基准, 见需求 Q8/Q13) ----------
// 目的: 无需真实两图即可标定全局相关的正确性与 PSR 阈值。
//   用例1 A-vs-A 自配准: B'=A → 期望绘制偏移 ≈ 0 (偏移不为 0 说明主判据系统性有偏)；
//   用例2 warpAffine 已知平移: 把 A 平移 (sx,sy) 合成 B' → 期望 solveGlobalTranslation 返回 (-sx,-sy)，还原误差应 < tolPx。
// 用法: 控制台执行 __alignSelfCheck() 或 __alignSelfCheck([[0,0],[20,-15],[-40,30]])。

// 用 warpAffine 把图 A 平移 (sx, sy) 合成一张 dataURL (BORDER_REPLICATE 补边, 与实拍同尺寸)
function makeTranslatedSrc(imgEl, sx, sy) {
  const src = cv.imread(imgEl);
  const dst = new cv.Mat();
  const M = cv.matFromArray(2, 3, cv.CV_32F, [1, 0, sx, 0, 1, sy]);
  const size = new cv.Size(src.cols, src.rows);
  let canvas = null;
  try {
    cv.warpAffine(src, dst, M, size, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    canvas = document.createElement('canvas');
    canvas.width = src.cols; canvas.height = src.rows;
    cv.imshow(canvas, dst);
    return canvas.toDataURL('image/png');
  } finally {
    src.delete(); dst.delete(); M.delete(); size.delete();
  }
}

// 全局相关自检: 对每个已知平移合成 B' 并跑 solveGlobalTranslation, 比对还原误差。
// 返回 { ok, passed, total, tolPx, results } (results 供 console.table 打印)
export async function selfCheckGlobalAlignment(calibImageA, shifts = [[0, 0], [20, -15], [-40, 30]], tolPx = 0.5) {
  const imgElA = await loadImageEl(calibImageA.src);
  const results = [];
  for (const [sx, sy] of shifts) {
    const expX = -sx, expY = -sy;   // B'=A平移(sx,sy) → 内部 d=(sx,sy) → 绘制偏移 t=-d=(-sx,-sy)
    try {
      // A-vs-A 用原图本身, 避免 warp 插值引入的伪差异; 其余用合成平移图
      const srcB = (sx === 0 && sy === 0) ? calibImageA.src : makeTranslatedSrc(imgElA, sx, sy);
      const res = await solveGlobalTranslation({ src: calibImageA.src }, { src: srcB });
      if (!res.ok) {
        results.push({ '平移': `(${sx}, ${sy})`, '期望偏移': `(${expX}, ${expY})`, '实测偏移': '—', '误差': '—', 'PSR': res.psr?.toFixed?.(1) ?? '—', '结论': `❌ 求解失败: ${res.message}` });
        continue;
      }
      const err = Math.hypot(res.dx - expX, res.dy - expY);
      const pass = err <= tolPx;
      results.push({
        '平移': `(${sx}, ${sy})`, '期望偏移': `(${expX}, ${expY})`,
        '实测偏移': `(${res.dx.toFixed(2)}, ${res.dy.toFixed(2)})`,
        '误差': err.toFixed(3) + 'px', 'PSR': res.psr.toFixed(1),
        '结论': pass ? '✅ 通过' : `❌ 超差 (> ${tolPx}px)`
      });
    } catch (e) {
      results.push({ '平移': `(${sx}, ${sy})`, '期望偏移': `(${expX}, ${expY})`, '实测偏移': '—', '误差': '—', 'PSR': '—', '结论': `❌ 异常: ${e?.message || e}` });
    }
  }
  const passed = results.filter(r => String(r['结论']).startsWith('✅')).length;
  return { ok: passed === results.length && results.length > 0, passed, total: results.length, tolPx, results };
}
