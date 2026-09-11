// @ts-ignore
/* global Vue, cv */

// 提取单环完整数据并编号 (供点击补环复用)
export function extractRingDataForManual(grayMat, centerX, centerY, radius) {
  return extractRingData(grayMat, centerX, centerY, radius);
}

// 主处理函数：检测牛顿环暗环 (两步式：先检测圆心供人工确认，再识别环)
export async function processNewtonRings(
  imageManager,
  showStatus,
  filterParams = null,
  resultImageRef = null
) {
  // 第一步：检测圆心 (自动识别，供人工确认/微调)
  const centerResult = await detectNewtonRingCenter(imageManager, showStatus, filterParams, resultImageRef);
  if (!centerResult) {
    throw new Error('无法检测到牛顿环中心，请检查图像质量');
  }
  // 第二步：圆心确认后识别环 (复用已预处理的图像)
  const darkRings = await detectRingsWithCenter(
    imageManager,
    showStatus,
    centerResult.x,
    centerResult.y,
    centerResult.processedDataUrl,
    centerResult.outerRadius,
    resultImageRef
  );

  if (darkRings.length === 0) {
    throw new Error('未检测到暗环，请调整图像参数后重试');
  }

  showStatus(`[100%] 完成！检测到 ${darkRings.length} 个暗环`, 'success');
}

// 第一步：预处理图像 + 自动检测圆心 (供人工确认，不识别环)
// 返回 { x, y, outerRadius, processedDataUrl }，预处理图以 DataURL 缓存供第二步复用，避免重复预处理
export async function detectNewtonRingCenter(imageManager, showStatus, filterParams = null, resultImageRef = null) {
  showStatus('[10%] 正在读取图像...', 'info');

  const originalImageUrl = imageManager.getOriginalImageSrc();
  if (!originalImageUrl) {
    throw new Error('图像未加载');
  }

  const originalImg = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法加载原始图像'));
    img.src = originalImageUrl;
  });

  const src = cv.imread(originalImg);
  let gray = null;
  let enhancedGray = null;
  let denoisedGray = null;
  try {
    showStatus('[20%] 正在预处理图像...', 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));

    gray = convertToGray(src);
    await showDebugImage('灰度图', gray, resultImageRef);

    showStatus('[40%] 正在检测圆心...', 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));
    // CLAHE 对比度增强 (降低参数避免过度增强噪声)
    enhancedGray = applyCLAHE(gray, 1.5, 16);
    await showDebugImage('CLAHE对比度增强', enhancedGray, resultImageRef);

    // 中值滤波去噪 (比高斯模糊更适合保留边缘)
    denoisedGray = applyMedianBlur(enhancedGray, 3);
    await showDebugImage('中值滤波去噪', denoisedGray, resultImageRef);

    // 用霍夫圆检测外边界获取精确圆心 (含径向对称性精修)
    const center = findCenterFromHough(denoisedGray);
    console.log(`检测到圆心: (${center.x.toFixed(1)}, ${center.y.toFixed(1)}), 外半径: ${center.outerRadius.toFixed(1)}`);

    if (center.x === 0 && center.y === 0) {
      return null;
    }

    // 调试：在预处理图上标注圆心与外边界，供人工目检确认
    const debugColor = new cv.Mat();
    cv.cvtColor(denoisedGray, debugColor, cv.COLOR_GRAY2BGR);
    const centerColor = new cv.Scalar(0, 0, 255, 255);
    cv.circle(debugColor, new cv.Point(center.x, center.y), 8, centerColor, 2);
    cv.line(debugColor, new cv.Point(center.x - 30, center.y), new cv.Point(center.x + 30, center.y), centerColor, 1);
    cv.line(debugColor, new cv.Point(center.x, center.y - 30), new cv.Point(center.x, center.y + 30), centerColor, 1);
    const outerColor = new cv.Scalar(255, 165, 0, 255);
    cv.circle(debugColor, new cv.Point(center.x, center.y), Math.round(center.outerRadius), outerColor, 2);
    // 保存含标注的调试图并转 DataURL 缓存，供第二步复用预处理结果 (不再重复预处理)
    await showDebugImage('圆心检测结果 (请确认)', debugColor, resultImageRef);
    const processedDataUrl = resultImageRef?.value?.src || null;
    debugColor.delete();

    showStatus(`✅ 圆心检测完成: (${center.x.toFixed(1)}, ${center.y.toFixed(1)})，请确认或微调`, 'success');

    return {
      x: center.x,
      y: center.y,
      outerRadius: center.outerRadius,
      processedDataUrl
    };
  } finally {
    src?.delete?.();
    gray?.delete?.();
    enhancedGray?.delete?.();
    denoisedGray?.delete?.();
  }
}

// 第二步：在确认后的圆心位置识别暗环 (径向剖面法)
// processedDataUrl 为第一步缓存的预处理图，为空时退化为从原图重新预处理 (尺寸不变时坐标一致)
export async function detectRingsWithCenter(imageManager, showStatus, centerX, centerY, processedDataUrl, outerRadius = 0, resultImageRef = null) {
  showStatus('[60%] 正在识别暗环...', 'info');
  await new Promise(resolve => requestAnimationFrame(resolve));

  // 加载预处理图 (含标注也无妨，径向剖面取灰度值；若含彩色标注则转灰度后影响极小)
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('预处理图像加载失败'));
    el.src = processedDataUrl;
  });
  let srcMat = cv.imread(img);
  if (srcMat.channels() > 1) {
    const tmp = new cv.Mat();
    cv.cvtColor(srcMat, tmp, cv.COLOR_BGR2GRAY);
    srcMat.delete();
    srcMat = tmp;
  }

  let darkRings = [];
  try {
    // 搜索范围限制到外边界 (无外边界时退化为图片短边的 48%)
    const fallback = Math.min(srcMat.cols, srcMat.rows) * 0.48;
    const maxRadius = outerRadius > 0 ? outerRadius * 0.98 : fallback;

    darkRings = detectDarkRingsRadial(srcMat, centerX, centerY, maxRadius);

    console.log(`检测结果 - 圆心(${centerX.toFixed(1)}, ${centerY.toFixed(1)}), 暗环数量: ${darkRings.length}`);
    if (darkRings.length > 0) {
      console.log(`暗环半径: ${darkRings.map(r => `环${r.number}: ${r.avgRadius.toFixed(1)}`).join(', ')}`);
    }

    showStatus(`[80%] 成功检测 ${darkRings.length} 个暗环，保存结果...`, 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));

    // 圆心随结果一并缓存 (供人工核对/重新识别复用)
    imageManager.saveCurrentResultToCache(darkRings, { x: centerX, y: centerY });
  } finally {
    srcMat?.delete?.();
  }

  return darkRings;
}

// 用霍夫圆检测外边界获取精确圆心
function findCenterFromHough(grayMat) {
  const cols = grayMat.cols;
  const rows = grayMat.rows;
  const minDim = Math.min(cols, rows);

  console.log(`霍夫圆检测圆心 - 图像尺寸: ${cols}x${rows}`);

  // 步骤1: Canny边缘检测
  const edges = new cv.Mat();
  cv.Canny(grayMat, edges, 50, 150, 3);

  // 步骤2: 霍夫圆检测 - 找最大的圆(外边界)
  const circles = new cv.Mat();
  try {
    cv.HoughCircles(
      grayMat, circles,
      cv.HOUGH_GRADIENT,
      1,        // dp
      minDim * 0.3,  // minDist - 圆之间最小距离
      100,      // param1 - Canny高阈值
      30,       // param2 - 累加器阈值(越小检测越多圆)
      Math.round(minDim * 0.3),  // minRadius
      Math.round(minDim * 0.5)   // maxRadius
    );
  } catch (e) {
    console.warn('霍夫圆检测异常:', e.message);
  }

  let bestCx = cols / 2, bestCy = rows / 2, bestR = minDim * 0.35;

  if (circles.cols > 0) {
    // 找最大的圆作为外边界
    let maxR = 0;
    for (let i = 0; i < circles.cols; i++) {
      const cx = circles.data32F[i * 3];
      const cy = circles.data32F[i * 3 + 1];
      const r = circles.data32F[i * 3 + 2];
      if (r > maxR && cx > 0 && cy > 0 && cx < cols && cy < rows) {
        maxR = r;
        bestCx = cx;
        bestCy = cy;
        bestR = r;
      }
    }
    console.log(`霍夫圆找到 ${circles.cols} 个圆, 最大圆: 中心(${bestCx.toFixed(1)},${bestCy.toFixed(1)}), 半径${bestR.toFixed(1)}`);
  } else {
    console.log('霍夫圆未检测到，使用亮度质心作为备选');
    // 备选方案：亮度加权质心
    const fallback = findCenterByBrightness(grayMat);
    bestCx = fallback.x;
    bestCy = fallback.y;
    // 估计外半径：从中心向外找亮度骤降的位置
    bestR = estimateOuterRadius(grayMat, bestCx, bestCy);
  }

  circles.delete();
  edges.delete();

  // 步骤3: 在霍夫圆结果附近做局部精修
  // 用径向对称性在 ±15px 范围内搜索最优中心
  const searchRange = 15;
  let refinedCx = bestCx, refinedCy = bestCy;
  let bestScore = Infinity;
  const testR = bestR * 0.5; // 用中等半径测试

  for (let dy = -searchRange; dy <= searchRange; dy += 2) {
    for (let dx = -searchRange; dx <= searchRange; dx += 2) {
      const tx = bestCx + dx;
      const ty = bestCy + dy;
      // 计算圆周上亮度标准差
      let sum = 0, sumSq = 0, count = 0;
      for (let i = 0; i < 60; i++) {
        const angle = (i * 2 * Math.PI) / 60;
        const px = tx + testR * Math.cos(angle);
        const py = ty + testR * Math.sin(angle);
        const ix = Math.round(px), iy = Math.round(py);
        if (ix >= 0 && ix < cols && iy >= 0 && iy < rows) {
          const v = grayMat.ucharAt(iy, ix);
          sum += v;
          sumSq += v * v;
          count++;
        }
      }
      if (count > 0) {
        const mean = sum / count;
        const std = Math.sqrt(sumSq / count - mean * mean);
        if (std < bestScore) {
          bestScore = std;
          refinedCx = tx;
          refinedCy = ty;
        }
      }
    }
  }

  console.log(`精修后圆心: (${refinedCx.toFixed(1)}, ${refinedCy.toFixed(1)}), 外半径: ${bestR.toFixed(1)}`);

  // 步骤4: 中心斑质心精修 —— 牛顿环中心最内圈有一块暗斑或亮斑，圆心应在该斑点几何中心居中；
  // 检测不到明显中心斑时回退径向对称性精修结果，不阻断流程 (人工确认阶段仍可微调)
  const spotCenter = refineCenterOnCentralSpot(grayMat, refinedCx, refinedCy, bestR);
  if (spotCenter) {
    console.log(`中心斑质心精修: (${refinedCx.toFixed(1)},${refinedCy.toFixed(1)}) → (${spotCenter.x.toFixed(1)},${spotCenter.y.toFixed(1)})，斑点类型: ${spotCenter.dark ? '暗斑' : '亮斑'}，半径 ≈ ${spotCenter.spotRadius.toFixed(1)}px`);
    refinedCx = spotCenter.x;
    refinedCy = spotCenter.y;
  } else {
    console.log('未检测到明显中心斑，保留径向对称性精修结果');
  }

  return { x: refinedCx, y: refinedCy, outerRadius: bestR };
}

// 中心斑质心精修：自动判断中心是暗斑还是亮斑，用极值加权质心把圆心收敛到斑点几何中心 (亚像素)。
// 检测不到明显斑点 (对比度太弱/形状异常/偏移过大) 时返回 null，调用方回退现有精修结果。
function refineCenterOnCentralSpot(grayMat, coarseCx, coarseCy, outerRadius) {
  const cols = grayMat.cols;
  const rows = grayMat.rows;
  if (coarseCx < 2 || coarseCy < 2 || coarseCx >= cols - 2 || coarseCy >= rows - 2) return null;

  // 1) 估计斑点半径与中心/背景亮度：沿 12 方向取平均径向剖面，找中心与外圈亮度跨越中点的位置 (自动兼容暗斑/亮斑)
  const numA = 12;
  const step = 0.5;
  const limit = Math.min(Math.max(outerRadius * 0.25, 12), 120);
  const profile = [];
  for (let r = 0; r <= limit; r += step) {
    let sum = 0, cnt = 0;
    for (let a = 0; a < numA; a++) {
      const ang = (a * 2 * Math.PI) / numA;
      const v = bilinearInterpolate(grayMat, coarseCx + r * Math.cos(ang), coarseCy + r * Math.sin(ang));
      if (v >= 0) { sum += v; cnt++; }
    }
    profile.push(cnt > 0 ? sum / cnt : null);
  }
  const head = profile.slice(0, 4).filter(v => v !== null);
  const tail = profile.slice(-6).filter(v => v !== null);
  if (head.length === 0 || tail.length === 0) return null;
  const centerVal = head.reduce((s, v) => s + v, 0) / head.length;
  const bgVal = tail.reduce((s, v) => s + v, 0) / tail.length;
  const contrast = Math.abs(bgVal - centerVal);
  if (contrast < 12) return null; // 斑点与背景对比度太弱，无法可靠定位 (回退)
  const isDark = centerVal < bgVal;

  const midVal = (centerVal + bgVal) / 2;
  let spotRadius = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i] === null || profile[i - 1] === null) continue;
    const crossed = isDark ? (profile[i - 1] < midVal && profile[i] >= midVal) : (profile[i - 1] > midVal && profile[i] <= midVal);
    if (crossed) { spotRadius = i * step; break; }
  }
  if (spotRadius < 2) spotRadius = Math.min(limit / 2, 10);

  // 2) 极值加权质心迭代：暗斑权重 = 背景 - 亮度，亮斑权重 = 亮度 - 背景，收敛到斑点几何中心；
  //    采样限定在斑点半径内 (窗口外的相邻亮环在暗斑权重公式下同样为正权重，会把质心拉偏)；
  //    每轮以上一轮质心为中心重新采样，自适应斑点实际位置。
  let cx = coarseCx, cy = coarseCy;
  for (let iter = 0; iter < 3; iter++) {
    const win = spotRadius;
    // 以当前候选中心重估剖面，确定本轮权重参考的背景亮度与斑点亮度方向基准是否仍成立 (自适应偏移)
    let sumX = 0, sumY = 0, sumW = 0;
    const x0 = Math.max(1, Math.floor(cx - win)), x1 = Math.min(cols - 2, Math.ceil(cx + win));
    const y0 = Math.max(1, Math.floor(cy - win)), y1 = Math.min(rows - 2, Math.ceil(cy + win));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > win * win) continue;
        const v = grayMat.ucharAt(y, x);
        const w = isDark ? bgVal - v : v - bgVal;
        if (w > 0) {
          sumX += x * w;
          sumY += y * w;
          sumW += w;
        }
      }
    }
    if (sumW <= 0) return null;
    const nx = sumX / sumW, ny = sumY / sumW;
    // 质心跳出斑点窗口太多：候选点不在斑内 (形状异常/误检)，回退
    if (Math.hypot(nx - cx, ny - cy) > win) return null;
    cx = nx;
    cy = ny;
  }

  // 最终圆心不得偏离粗定位过多 (防止亮斑/异常区域把圆心拉飞)
  if (Math.hypot(cx - coarseCx, cy - coarseCy) > Math.max(spotRadius * 2, 25)) return null;
  return { x: cx, y: cy, dark: isDark, spotRadius };
}

// 备选：亮度加权质心
function findCenterByBrightness(grayMat) {
  const cols = grayMat.cols;
  const rows = grayMat.rows;
  let sumX = 0, sumY = 0, sumW = 0;
  let maxVal = 0;
  for (let y = 0; y < rows; y += 2) {
    for (let x = 0; x < cols; x += 2) {
      const v = grayMat.ucharAt(y, x);
      if (v > maxVal) maxVal = v;
    }
  }
  const threshold = maxVal * 0.75;
  for (let y = 0; y < rows; y += 2) {
    for (let x = 0; x < cols; x += 2) {
      const v = grayMat.ucharAt(y, x);
      if (v > threshold) {
        const w = v - threshold;
        sumX += x * w;
        sumY += y * w;
        sumW += w;
      }
    }
  }
  return {
    x: sumW > 0 ? sumX / sumW : cols / 2,
    y: sumW > 0 ? sumY / sumW : rows / 2
  };
}

// 估计外半径：从中心向外找亮度骤降的位置
function estimateOuterRadius(grayMat, cx, cy) {
  const cols = grayMat.cols;
  const rows = grayMat.rows;
  const maxR = Math.min(cols, rows) * 0.48;
  // 沿4个方向采样取平均
  let bestR = maxR * 0.7;
  let minIntensity = 255;
  for (let r = Math.round(maxR * 0.3); r <= maxR; r++) {
    let avgIntensity = 0;
    let count = 0;
    for (let a = 0; a < 4; a++) {
      const angle = (a * Math.PI) / 4;
      const px = Math.round(cx + r * Math.cos(angle));
      const py = Math.round(cy + r * Math.sin(angle));
      if (px >= 0 && px < cols && py >= 0 && py < rows) {
        avgIntensity += grayMat.ucharAt(py, px);
        count++;
      }
    }
    if (count > 0) {
      avgIntensity /= count;
      if (avgIntensity < minIntensity) {
        minIntensity = avgIntensity;
        bestR = r;
      }
    }
  }
  return bestR;
}

// 径向剖面法检测暗环 (双线性插值 + Savitzky-Golay平滑 + 直接最小值检测)
function detectDarkRingsRadial(grayMat, centerX, centerY, maxRadius) {
  const rings = [];
  const numAngles = 72;
  const cosTable = new Float32Array(numAngles);
  const sinTable = new Float32Array(numAngles);
  for (let i = 0; i < numAngles; i++) {
    const angle = (i * 2 * Math.PI) / numAngles;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  const allMinima = [];
  for (let angleIdx = 0; angleIdx < numAngles; angleIdx++) {
    const profile = [];
    const cos = cosTable[angleIdx];
    const sin = sinTable[angleIdx];

    // 双线性插值采样，步长0.5像素提高精度
    for (let r = 5; r <= maxRadius; r += 0.5) {
      const fx = centerX + r * cos;
      const fy = centerY + r * sin;
      const intensity = bilinearInterpolate(grayMat, fx, fy);
      if (intensity >= 0) {
        profile.push({ radius: r, intensity });
      }
    }
    // Savitzky-Golay 平滑 (窗口5, 二次多项式)
    const smoothed = savitzkyGolaySmooth(profile.map(p => p.intensity), 5, 2);
    for (let i = 0; i < profile.length; i++) {
      profile[i].smoothedIntensity = smoothed[i];
    }
    // 直接找平滑后的局部最小值
    const minima = findMinimaDirect(profile, maxRadius);
    allMinima.push(...minima);
  }

  console.log(`找到 ${allMinima.length} 个候选最小值点`);
  const clusteredRings = clusterRadiiByPhysics(allMinima, numAngles);

  console.log(`聚类后得到 ${clusteredRings.length} 个暗环`);
  for (const ringRadius of clusteredRings) {
    const ringData = extractRingData(grayMat, centerX, centerY, ringRadius);
    if (ringData) {
      rings.push(ringData);
    }
  }
  return sortRings(rings);
}

// 双线性插值采样
function bilinearInterpolate(mat, fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= mat.cols || y1 >= mat.rows) return -1;
  const dx = fx - x0, dy = fy - y0;
  const v00 = mat.ucharAt(y0, x0);
  const v10 = mat.ucharAt(y0, x1);
  const v01 = mat.ucharAt(y1, x0);
  const v11 = mat.ucharAt(y1, x1);
  return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
}

// Savitzky-Golay 平滑滤波器 (简化版，窗口5，二次多项式)
function savitzkyGolaySmooth(data, windowSize, polyOrder) {
  const n = data.length;
  const result = new Float32Array(n);
  const half = Math.floor(windowSize / 2);
  // 窗口5二次多项式的SG系数: [-3, 12, 17, 12, -3] / 35
  const sgCoeffs = [-3, 12, 17, 12, -3];
  const sgDivisor = 35;

  for (let i = 0; i < n; i++) {
    if (i < half || i >= n - half) {
      // 边界用原始值
      result[i] = data[i];
    } else {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        sum += sgCoeffs[j + half] * data[i + j];
      }
      result[i] = sum / sgDivisor;
    }
  }
  return result;
}

// 直接找平滑后剖面的局部最小值 (暗环 = 亮度谷底)
function findMinimaDirect(profile, maxRadius) {
  if (profile.length < 10) return [];

  const minima = [];
  const n = profile.length;

  // 估计当前半径处的预期环间距
  // 牛顿环 r_m² = m*λR，所以 dr/dm = λR/(2r) ≈ r/(2m)
  // 粗略估计：总环数约20-25，平均间距 = maxRadius/22
  const avgSpacing = maxRadius / 22;

  for (let i = 3; i < n - 3; i++) {
    const current = profile[i].smoothedIntensity;
    const r = profile[i].radius;
    // 动态checkRange：约为预期间距的1/3
    const checkRange = Math.max(2, Math.round(avgSpacing / 3));
    const iStart = Math.max(0, i - checkRange);
    const iEnd = Math.min(n - 1, i + checkRange);

    // 检查是否是局部最小值
    let isMin = true;
    for (let j = iStart; j <= iEnd; j++) {
      if (j !== i && profile[j].smoothedIntensity < current) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;

    // 计算对比度：与两侧较大范围比较
    const sideRange = Math.max(5, Math.round(avgSpacing / 2));
    const leftStart = Math.max(0, i - sideRange * 2);
    const rightEnd = Math.min(n - 1, i + sideRange * 2);
    let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
    for (let j = leftStart; j < i - sideRange; j++) {
      leftSum += profile[j].smoothedIntensity;
      leftCount++;
    }
    for (let j = i + sideRange + 1; j <= rightEnd; j++) {
      rightSum += profile[j].smoothedIntensity;
      rightCount++;
    }
    const surroundingAvg = ((leftCount > 0 ? leftSum / leftCount : current) +
                            (rightCount > 0 ? rightSum / rightCount : current)) / 2;
    const contrast = surroundingAvg - current;

    // 提高对比度阈值，只保留明显的暗环
    const minContrast = 15;

    if (contrast > minContrast) {
      // 抛物线亚像素精修: 用谷底相邻三点 (i-1, i, i+1) 的平滑强度拟合抛物线, 顶点即暗环真实半径 (亚像素)。
      // 采样步长 0.5px 会把谷底量化到 0.5 的倍数 (对称环凑成整数 → 直径 .00 假精度),
      // 抛物线顶点能恢复出如 189.23 这样的亚像素半径; 椭圆拟合到整数点救不回这个精度, 必须在源头修。
      let subR = r;
      const y0 = profile[i - 1].smoothedIntensity;
      const y1 = profile[i].smoothedIntensity;
      const y2 = profile[i + 1].smoothedIntensity;
      const denom = y0 - 2 * y1 + y2;   // 谷底处二阶差分 > 0
      if (Math.abs(denom) > 1e-6) {
        const p = 0.5 * (y0 - y2) / denom;   // 顶点相对中心的偏移 (单位: 采样索引步)
        if (Math.abs(p) < 1) subR = r + p * 0.5;   // 索引步 = 0.5px; |p|<1 才可信, 否则保留原值
      }
      minima.push({ radius: subR, contrast, intensity: current });
    }
  }

  // 非极大值抑制：间距至少为预期环间距的60%
  const suppressed = [];
  minima.sort((a, b) => a.radius - b.radius);
  const minDist = avgSpacing * 0.6;
  for (const m of minima) {
    if (suppressed.length === 0 || m.radius - suppressed[suppressed.length - 1].radius > minDist) {
      suppressed.push(m);
    } else if (m.contrast > suppressed[suppressed.length - 1].contrast) {
      suppressed[suppressed.length - 1] = m;
    }
  }

  return suppressed;
}

// 基于牛顿环物理规律 r²∝m 的聚类策略 + 二次拟合精修
function clusterRadiiByPhysics(minima, numAngles) {
  if (minima.length === 0) return [];

  minima.sort((a, b) => a.radius - b.radius);

  // 第一步：聚类 (容差为预期环间距的40%)
  const clusters = [];
  let currentCluster = [minima[0]];
  // 估计平均环间距
  const maxR = minima[minima.length - 1].radius;
  const avgSpacing = maxR / 22;
  const clusterTolerance = avgSpacing * 0.4;

  for (let i = 1; i < minima.length; i++) {
    const avgR = currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length;
    const currRadius = minima[i].radius;

    if (currRadius - avgR <= clusterTolerance) {
      currentCluster.push(minima[i]);
    } else {
      clusters.push({
        radius: currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length,
        count: currentCluster.length
      });
      currentCluster = [minima[i]];
    }
  }
  if (currentCluster.length > 0) {
    clusters.push({
      radius: currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length,
      count: currentCluster.length
    });
  }

  console.log(`初步聚类: ${clusters.length} 个候选环`);

  // 第二步：过滤出现次数太少的 (至少20%角度出现)
  const minOccurrences = Math.max(8, Math.ceil(numAngles * 0.2));
  let validClusters = clusters.filter(c => c.count >= minOccurrences && c.radius >= 10);

  if (validClusters.length < 3) {
    console.log(`有效聚类太少(${validClusters.length})，降低阈值`);
    const lowerThreshold = Math.max(5, Math.ceil(numAngles * 0.12));
    validClusters = clusters.filter(c => c.count >= lowerThreshold && c.radius >= 10);
  }

  if (validClusters.length < 3) {
    console.log('仍然太少，返回所有聚类');
    return clusters.map(c => c.radius);
  }

  // 第三步：r²∝m 二次拟合精修
  // r_m² = a*m + b，对 r² 做线性回归
  const radii = validClusters.map(c => c.radius);
  const rSquared = radii.map(r => r * r);
  const n = rSquared.length;

  // 线性回归: r² = a*m + b，其中 m = 1,2,3,...
  const mValues = [];
  for (let i = 0; i < n; i++) mValues.push(i + 1);

  const sumM = mValues.reduce((a, b) => a + b, 0);
  const sumR2 = rSquared.reduce((a, b) => a + b, 0);
  const sumMR2 = mValues.reduce((sum, m, i) => sum + m * rSquared[i], 0);
  const sumM2 = mValues.reduce((sum, m) => sum + m * m, 0);

  const slope = (n * sumMR2 - sumM * sumR2) / (n * sumM2 - sumM * sumM);
  const intercept = (sumR2 - slope * sumM) / n;

  console.log(`r²线性拟合: 斜率=${slope.toFixed(1)}, 截距=${intercept.toFixed(1)}`);

  // 用拟合值修正每个环的半径
  const refinedRadii = [];
  for (let i = 0; i < n; i++) {
    const expectedR2 = slope * (i + 1) + intercept;
    if (expectedR2 > 0) {
      const expectedR = Math.sqrt(expectedR2);
      // 只在偏差较大时才修正 (偏差>15%才修正)
      const deviation = Math.abs(radii[i] - expectedR) / expectedR;
      if (deviation > 0.15) {
        console.log(`环${i + 1}: 检测值${radii[i].toFixed(1)} → 修正为${expectedR.toFixed(1)} (偏差${(deviation * 100).toFixed(0)}%)`);
        refinedRadii.push(expectedR);
      } else {
        refinedRadii.push(radii[i]);
      }
    } else {
      refinedRadii.push(radii[i]);
    }
  }

  console.log(`最终输出 ${refinedRadii.length} 个暗环`);
  return refinedRadii;
}

// 排序暗环并编号 (从小到大)
export function sortRings(rings) {
  if (!rings || rings.length === 0) return [];
  rings.sort((a, b) => a.avgRadius - b.avgRadius);
  rings.forEach((ring, index) => ring.number = index + 1);
  return rings;
}

// 合并自动检测环与手动补环，按半径重新排序编号 (供点击补环使用)
export function mergeAndNumberRings(rings) {
  return sortRings([...(rings || [])]);
}

// 提取暗环完整数据 (关键点、椭圆拟合)
function extractRingData(grayMat, centerX, centerY, radius) {
  try {
    const points = [];
    const numSamples = 72;
    // 采样圆周上的点
    for (let i = 0; i < numSamples; i++) {
      const angle = (i * 2 * Math.PI) / numSamples;
      const x = Math.round(centerX + radius * Math.cos(angle));
      const y = Math.round(centerY + radius * Math.sin(angle));

      if (x >= 0 && x < grayMat.cols && y >= 0 && y < grayMat.rows) {
        points.push({ x, y });
      }
    }

    if (points.length < 8) return null;
    // 找上下左右4个关键点 (整数坐标, 仅作回退与绘制用)
    const keyPoints = findKeyPoints(points);
    // 椭圆拟合 (亚像素): 对全部 72 个采样点做最小二乘, 长短轴是浮点亚像素值,
    // 比「4 个整数关键点距离平均」精度高一个量级, 且对噪声/不够圆的环更鲁棒
    const ellipse = fitEllipse(points);

    // 直径精度来源: 优先椭圆长短半轴均值 (亚像素); 椭圆失败/退化时回退整数关键点平均
    const keyPointRadius = (
      distance(keyPoints.top, { x: centerX, y: centerY }) +
      distance(keyPoints.bottom, { x: centerX, y: centerY }) +
      distance(keyPoints.left, { x: centerX, y: centerY }) +
      distance(keyPoints.right, { x: centerX, y: centerY })
    ) / 4;
    const ellipseRadius = (ellipse && ellipse.size.width > 0 && ellipse.size.height > 0)
      ? (ellipse.size.width + ellipse.size.height) / 4
      : null;
    const avgRadius = ellipseRadius !== null ? ellipseRadius : keyPointRadius;

    return {
      x: centerX,
      y: centerY,
      avgRadius,
      keyPoints,
      ellipse
    };

  } catch (error) {
    console.error('提取暗环数据失败:', error);
    return null;
  }
}

// 查找上下左右4个关键点
function findKeyPoints(points) {
  let top = points[0], bottom = points[0], left = points[0], right = points[0];

  for (const point of points) {
    if (point.y < top.y) top = point;
    if (point.y > bottom.y) bottom = point;
    if (point.x < left.x) left = point;
    if (point.x > right.x) right = point;
  }

  return { top, bottom, left, right };
}

// 计算两点距离
function distance(p1, p2) {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

// 椭圆拟合 (使用 OpenCV fitEllipse)
function fitEllipse(points) {
  if (points.length < 5) return null;

  try {
    const pointsMat = cv.matFromArray(points.length, 1, cv.CV_32SC2,
      points.flatMap(p => [p.x, p.y])
    );

    const rotatedRect = cv.fitEllipse(pointsMat);
    pointsMat?.delete?.();

    return {
      center: { x: rotatedRect.center.x, y: rotatedRect.center.y },
      size: { width: rotatedRect.size.width, height: rotatedRect.size.height },
      angle: rotatedRect.angle
    };

  } catch (error) {
    console.warn('椭圆拟合失败:', error);
    return null;
  }
}

// ===== 图像预处理函数集 =====

// 将 RGBA 图像转换为灰度图
function convertToGray(srcMat) {
  const grayMat = new cv.Mat();
  cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);
  return grayMat;
}

// 高斯模糊去噪
function applyGaussianBlur(srcMat, kernelSize = 5) {
  const blurredMat = new cv.Mat();
  cv.GaussianBlur(srcMat, blurredMat, new cv.Size(kernelSize, kernelSize), 0);
  return blurredMat;
}

// 锐化增强边缘 (使用拉普拉斯算子)
function applySharpen(srcMat, strength = 1.5) {
  const sharpenedMat = new cv.Mat();

  const kernel = new cv.Mat(3, 3, cv.CV_32F);
  // 锐化核：增强中心像素，减弱周围像素
  const kernelData = new Float32Array([
    0, -1, 0,
    -1, 5, -1,
    0, -1, 0
  ]);
  kernel.data32F.set(kernelData);

  cv.filter2D(srcMat, sharpenedMat, -1, kernel);
  // 如果强度不是1.0，混合原图和锐化结果
  if (strength !== 1.0) {
    const blended = new cv.Mat();
    cv.addWeighted(srcMat, 1.0, sharpenedMat, strength - 1.0, 0, blended);
    sharpenedMat.delete();
    return blended;
  }

  kernel.delete();
  return sharpenedMat;
}

// CLAHE 对比度增强
function applyCLAHE(srcMat, clipLimit = 2.0, tileGridSize = 8) {
  const enhancedMat = srcMat.clone();
  const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileGridSize, tileGridSize));
  clahe.apply(enhancedMat, enhancedMat);
  clahe.delete();
  return enhancedMat;
}

// 中值滤波去噪
function applyMedianBlur(srcMat, kernelSize = 5) {
  const filteredMat = new cv.Mat();
  cv.medianBlur(srcMat, filteredMat, kernelSize);
  return filteredMat;
}

// 标定图预处理 (仅用于显示层增强，帮助人眼捕捉特征点)
// 管线: 灰度 → 中值滤波去噪(3) → CLAHE 局部对比度 → Unsharp 锐化
// 保证: 全部为同尺寸逐像素值运算，不改变任何像素的几何位置，特征点坐标处理前后完全一致；
//       原图数据由调用方单独保留，本函数只处理传入副本并返回新 Mat (调用方负责 delete)
export function preprocessCalibForDisplay(srcMat, { claheStrength = 2.5, sharpenSigma = 1.2 } = {}) {
  let gray = null, denoised = null, enhanced = null, blurred = null;
  try {
    gray = new cv.Mat();
    if (srcMat.channels() > 1) {
      cv.cvtColor(srcMat, gray, cv.COLOR_BGR2GRAY);
    } else {
      srcMat.copyTo(gray);
    }
    denoised = applyMedianBlur(gray, 3);
    enhanced = applyCLAHE(denoised, claheStrength, 16);
    // Unsharp 锐化: 结果 = 1.5×增强图 − 0.5×高斯模糊图 (温和参数，避免过冲产生假边缘)
    blurred = new cv.Mat();
    cv.GaussianBlur(enhanced, blurred, new cv.Size(0, 0), sharpenSigma);
    const sharp = new cv.Mat();
    cv.addWeighted(enhanced, 1.5, blurred, -0.5, 0, sharp);
    // 尺寸校验关卡: 处理后必须与原图宽高完全一致，否则丢弃结果 (保证特征点坐标有效)
    if (sharp.cols !== srcMat.cols || sharp.rows !== srcMat.rows) {
      const msg = `尺寸校验失败 (${sharp.cols}x${sharp.rows} ≠ ${srcMat.cols}x${srcMat.rows})`;
      sharp.delete();
      throw new Error(msg);
    }
    return sharp;
  } finally {
    gray?.delete();
    denoised?.delete();
    enhanced?.delete();
    blurred?.delete();
  }
}

// 自适应阈值二值化
function applyAdaptiveThreshold(srcMat, blockSize = 15, C = 2, thresholdType = cv.THRESH_BINARY_INV) {
  const binaryMat = new cv.Mat();
  cv.adaptiveThreshold(
    srcMat,
    binaryMat,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    thresholdType,
    blockSize,
    C
  );
  return binaryMat;
}

// 形态学开运算 (去噪)
function applyMorphOpen(srcMat, kernelSize = 3) {
  const morphMat = new cv.Mat();
  const kernel = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
  cv.morphologyEx(srcMat, morphMat, cv.MORPH_OPEN, kernel);
  kernel.delete();
  return morphMat;
}

// 形态学闭运算 (连接断裂区域)
function applyMorphClose(srcMat, kernelSize = 5) {
  const morphMat = new cv.Mat();
  const kernel = cv.Mat.ones(kernelSize, kernelSize, cv.CV_8U);
  cv.morphologyEx(srcMat, morphMat, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return morphMat;
}

// 应用用户自定义的 CLAHE 参数
function applyUserCLAHE(grayMat, filterParams) {
  if (!filterParams || (filterParams.claheClip <= 1 && filterParams.claheTile <= 4)) {
    return grayMat.clone();
  }

  return applyCLAHE(grayMat, filterParams.claheClip, filterParams.claheTile);
}

// 应用用户自定义的中值滤波参数
function applyUserMedianBlur(grayMat, filterParams) {
  if (!filterParams || filterParams.blur <= 0) {
    return grayMat.clone();
  }

  const kernelSize = Math.max(3, Math.round(filterParams.blur) * 2 + 1);
  return applyMedianBlur(grayMat, kernelSize);
}

// ===== 调试工具 =====

// 延迟指定毫秒数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 直接改写结果图片显示处理过程 (用于调试)
async function showDebugImage(title, mat, resultImageRef) {
  const canvas = document.createElement('canvas');
  cv.imshow(canvas, mat);
  const dataUrl = canvas.toDataURL('image/png');
  canvas.remove();

  resultImageRef.value.src = dataUrl;

  console.log(`🔍 调试: ${title} (${mat.cols}x${mat.rows})`);

  await sleep(300);
  // debugger
}
