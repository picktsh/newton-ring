// @ts-ignore
/* global Vue, cv */

// 主处理函数：检测牛顿环暗环
export async function processNewtonRings(
  imageManager,
  showStatus,
  filterParams = null,
  resultImageRef = null
) {
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

  await showDebugImage('原始图像', src, resultImageRef);
  showStatus('[20%] 正在预处理图像...', 'info');
  await new Promise(resolve => requestAnimationFrame(resolve));

  let gray = null;
  try {
    // 转换为灰度图
    gray = convertToGray(src);
    await showDebugImage('灰度图', gray, resultImageRef);

    showStatus('[40%] 正在检测暗环轮廓...', 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));
    // CLAHE 对比度增强 (降低参数避免过度增强噪声)
    const enhancedGray = applyCLAHE(gray, 1.5, 16);
    await showDebugImage('CLAHE对比度增强', enhancedGray, resultImageRef);

    // 中值滤波去噪 (比高斯模糊更适合保留边缘)
    const denoisedGray = applyMedianBlur(enhancedGray, 3);
    await showDebugImage('中值滤波去噪', denoisedGray, resultImageRef);

    // 检测牛顿环暗环 (直接用灰度图做径向剖面)
    const darkRings = await detectNewtonRings(gray, denoisedGray, resultImageRef);


    if (darkRings.length === 0) {
      throw new Error('未检测到暗环，请调整图像参数后重试');
    }

    showStatus(`[60%] 检测到 ${darkRings.length} 个暗环，正在处理...`, 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));

    console.log(`检测结果 - 中心点: (${darkRings[0].x.toFixed(1)}, ${darkRings[0].y.toFixed(1)}), 暗环数量: ${darkRings.length}`);

    showStatus(`[80%] 成功检测 ${darkRings.length} 个暗环，保存结果...`, 'info');
    await new Promise(resolve => requestAnimationFrame(resolve));

    imageManager.saveCurrentResultToCache(darkRings);

    showStatus('[100%] 完成！', 'success');

    denoisedGray?.delete?.();
    enhancedGray?.delete?.();
  } finally {
    src?.delete?.();
    gray?.delete?.();
  }
}


// 检测牛顿环 (圆心定位 + 径向剖面法)
async function detectNewtonRings(grayMat, processedMat, resultImageRef) {
  try {
    const rows = processedMat.rows;
    const cols = processedMat.cols;

    console.log(`开始牛顿环检测 - 图像尺寸: ${cols}x${rows}`);
    // 用霍夫圆检测外边界获取精确圆心
    const center = findCenterFromHough(processedMat);
    const centerX = center.x;
    const centerY = center.y;
    const maxRadius = center.outerRadius * 0.98;

    console.log(`检测到圆心: (${centerX.toFixed(1)}, ${centerY.toFixed(1)}), 外半径: ${center.outerRadius.toFixed(1)}`);
    // 调试：显示圆心位置
    const debugColor = new cv.Mat();
    cv.cvtColor(processedMat, debugColor, cv.COLOR_GRAY2BGR);
    const centerColor = new cv.Scalar(0, 0, 255, 255);
    cv.circle(debugColor, new cv.Point(centerX, centerY), 8, centerColor, 2);
    cv.line(debugColor, new cv.Point(centerX - 30, centerY), new cv.Point(centerX + 30, centerY), centerColor, 1);
    cv.line(debugColor, new cv.Point(centerX, centerY - 30), new cv.Point(centerX, centerY + 30), centerColor, 1);
    // 画外边界圆
    const outerColor = new cv.Scalar(255, 165, 0, 255);
    cv.circle(debugColor, new cv.Point(centerX, centerY), Math.round(center.outerRadius), outerColor, 2);
    await showDebugImage('圆心检测结果', debugColor, resultImageRef);
    debugColor.delete();

    if (centerX === 0 || centerY === 0) {
      throw new Error('无法检测到牛顿环中心，请检查图像质量');
    }
    // 径向剖面法检测暗环
    const darkRings = detectDarkRingsRadial(processedMat, centerX, centerY, maxRadius);

    console.log(`检测结果 - 暗环数量: ${darkRings.length}`);
    if (darkRings.length > 0) {
      console.log(`暗环半径: ${darkRings.map(r => `环${r.number}: ${r.avgRadius.toFixed(1)}`).join(', ')}`);
    }

    return darkRings;

  } catch (error) {
    console.error('牛顿环检测失败:', error);
    return [];
  }
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
  return { x: refinedCx, y: refinedCy, outerRadius: bestR };
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
    const minima = findMinimaDirect(profile);
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
function findMinimaDirect(profile) {
  if (profile.length < 10) return [];

  const minima = [];
  const n = profile.length;
  // 自适应窗口：根据当前位置的半径估计环间距
  // 牛顿环间距 dr ≈ Rλ/(2r)，随r增大而减小
  // 用固定最小间距3像素，最大间距15像素

  for (let i = 3; i < n - 3; i++) {
    const current = profile[i].smoothedIntensity;
    // 检查是否是局部最小值
    let isMin = true;
    const checkRange = 3;
    for (let j = i - checkRange; j <= i + checkRange; j++) {
      if (j !== i && profile[j].smoothedIntensity < current) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;

    // 计算对比度：与两侧平均值比较
    const leftStart = Math.max(0, i - 8);
    const rightEnd = Math.min(n - 1, i + 8);
    let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
    for (let j = leftStart; j < i - 3; j++) {
      leftSum += profile[j].smoothedIntensity;
      leftCount++;
    }
    for (let j = i + 4; j <= rightEnd; j++) {
      rightSum += profile[j].smoothedIntensity;
      rightCount++;
    }
    const surroundingAvg = ((leftCount > 0 ? leftSum / leftCount : current) +
                            (rightCount > 0 ? rightSum / rightCount : current)) / 2;
    const contrast = surroundingAvg - current;

    // 自适应对比度阈值
    const radiusRatio = profile[i].radius / n;
    const minContrast = radiusRatio < 0.3 ? 10 : (radiusRatio < 0.6 ? 6 : 4);

    if (contrast > minContrast) {
      minima.push({ radius: profile[i].radius, contrast, intensity: current });
    }
  }

  // 非极大值抑制：间距太近的只保留对比度最高的
  const suppressed = [];
  minima.sort((a, b) => a.radius - b.radius);
  for (const m of minima) {
    if (suppressed.length === 0 || m.radius - suppressed[suppressed.length - 1].radius > 3) {
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

  // 第一步：宽松聚类 (容差随半径自适应)
  const clusters = [];
  let currentCluster = [minima[0]];

  for (let i = 1; i < minima.length; i++) {
    const avgR = currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length;
    const currRadius = minima[i].radius;
    // 自适应容差：外圈环密，容差小；内圈环疏，容差大
    const adaptiveTolerance = Math.max(2, 6 - avgR * 0.015);

    if (currRadius - avgR <= adaptiveTolerance) {
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

  // 第二步：过滤出现次数太少的
  const minOccurrences = Math.max(5, Math.ceil(numAngles * 0.15));
  let validClusters = clusters.filter(c => c.count >= minOccurrences && c.radius >= 8);

  if (validClusters.length < 3) {
    console.log(`有效聚类太少(${validClusters.length})，降低阈值`);
    const lowerThreshold = Math.max(3, Math.ceil(numAngles * 0.1));
    validClusters = clusters.filter(c => c.count >= lowerThreshold && c.radius >= 8);
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
function sortRings(rings) {
  if (!rings || rings.length === 0) return [];
  rings.sort((a, b) => a.avgRadius - b.avgRadius);
  rings.forEach((ring, index) => ring.number = index + 1);
  return rings;
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
    // 找上下左右4个关键点
    const keyPoints = findKeyPoints(points);

    const avgRadius = (
      distance(keyPoints.top, { x: centerX, y: centerY }) +
      distance(keyPoints.bottom, { x: centerX, y: centerY }) +
      distance(keyPoints.left, { x: centerX, y: centerY }) +
      distance(keyPoints.right, { x: centerX, y: centerY })
    ) / 4;
    // 椭圆拟合
    const ellipse = fitEllipse(points);

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
