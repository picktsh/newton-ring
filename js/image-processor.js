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
    // CLAHE 对比度增强
    const enhancedGray = applyCLAHE(gray, 2, 8);
    await showDebugImage('CLAHE对比度增强', enhancedGray, resultImageRef);

    // 轻度高斯模糊去噪
    const blurredGray = applyGaussianBlur(enhancedGray, 9);
    await showDebugImage('轻度高斯模糊', blurredGray, resultImageRef);

    // 自适应阈值二值化
    const adaptiveBinary = applyAdaptiveThreshold(blurredGray, 41, 5, cv.THRESH_BINARY);
    await showDebugImage('自适应阈值', adaptiveBinary, resultImageRef);

    // 形态学闭运算连接断裂区域
    const closedBinary = applyMorphClose(adaptiveBinary, 2);
    await showDebugImage('形态学闭运算', closedBinary, resultImageRef);

    // 检测牛顿环暗环
    const darkRings = await detectNewtonRings(gray, adaptiveBinary, resultImageRef);


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

    blurredGray?.delete?.();
    enhancedGray?.delete?.();
    adaptiveBinary?.delete?.();
    closedBinary?.delete?.();
  } finally {
    src?.delete?.();
    gray?.delete?.();
  }
}


// 检测牛顿环 (圆心定位 + 径向剖面法)
async function detectNewtonRings(grayMat, binaryMat, resultImageRef) {
  try {
    const rows = binaryMat.rows;
    const cols = binaryMat.cols;

    console.log(`开始牛顿环检测 - 图像尺寸: ${cols}x${rows}`);
    // 从二值图中检测圆心 (光斑质心)
    const center = findCenterFromBinary(binaryMat);
    const centerX = center.x;
    const centerY = center.y;
    const maxRadius = Math.min(cols, rows) / 2 * 0.9;

    console.log(`检测到圆心: (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`);
    // 调试：显示圆心位置
    const debugColor = new cv.Mat();
    cv.cvtColor(binaryMat, debugColor, cv.COLOR_GRAY2BGR);
    const centerColor = new cv.Scalar(0, 0, 255, 255);
    cv.circle(debugColor, new cv.Point(centerX, centerY), 5, centerColor, -1);
    await showDebugImage('圆心检测结果', debugColor, resultImageRef);
    debugColor.delete();

    if (centerX === 0 || centerY === 0) {
      throw new Error('无法检测到牛顿环中心，请检查图像质量');
    }
    // 径向剖面法检测暗环
    const darkRings = detectDarkRingsRadial(grayMat, centerX, centerY, maxRadius);

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

// 从二值图中检测圆心 (光斑质心法)
function findCenterFromBinary(binaryMat) {
  const cols = binaryMat.cols;
  const rows = binaryMat.rows;

  console.log(`开始检测圆心 - 二值图尺寸: ${cols}x${rows}`);
  // 调试：统计白色像素比例
  let whitePixels = 0;
  const totalPixels = cols * rows;
  for (let y = 0; y < rows; y += 10) {
    for (let x = 0; x < cols; x += 10) {
      if (binaryMat.ucharAt(y, x) > 128) {
        whitePixels++;
      }
    }
  }
  console.log(`白色像素比例（采样）: ${(whitePixels / (totalPixels / 100)).toFixed(2)}%`);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binaryMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  console.log(`找到 ${contours.size()} 个轮廓`);
  // 查找最大轮廓的质心作为圆心
  let maxArea = 0;
  let centerX = 0;
  let centerY = 0;
  let bestIdx = -1;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area > maxArea) {
      maxArea = area;
      const moments = cv.moments(contour);
      if (moments.m00 !== 0) {
        centerX = moments.m10 / moments.m00;
        centerY = moments.m01 / moments.m00;
        bestIdx = i;
      }
    }
  }

  contours.delete();
  hierarchy.delete();

  if (maxArea === 0) {
    console.error(`未检测到光斑区域 - 最大面积: ${maxArea}`);
    throw new Error('未检测到光斑区域');
  }

  console.log(`光斑质心: (${centerX.toFixed(1)}, ${centerY.toFixed(1)}), 面积: ${maxArea.toFixed(0)}, 轮廓索引: ${bestIdx}`);

  return { x: centerX, y: centerY };
}

// 径向剖面法检测暗环 (沿72个角度采样)
function detectDarkRingsRadial(grayMat, centerX, centerY, maxRadius) {
  const rings = [];
  const numAngles = 72; // 每5度一个采样角度
  // 预计算三角函数表 (性能优化)
  const cosTable = new Float32Array(numAngles);
  const sinTable = new Float32Array(numAngles);
  for (let i = 0; i < numAngles; i++) {
    const angle = (i * 2 * Math.PI) / numAngles;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  const allMinima = [];
  // 沿每个角度进行径向采样
  for (let angleIdx = 0; angleIdx < numAngles; angleIdx++) {
    const profile = [];
    const cos = cosTable[angleIdx];
    const sin = sinTable[angleIdx];

    for (let r = 15; r <= maxRadius; r += 1) {
      const x = Math.round(centerX + r * cos);
      const y = Math.round(centerY + r * sin);

      if (x >= 0 && x < grayMat.cols && y >= 0 && y < grayMat.rows) {
        const intensity = grayMat.ucharAt(y, x);
        profile.push({ radius: r, intensity });
      }
    }
    // 查找局部最小值 (暗环位置)
    const minima = findLocalMinima(profile);
    allMinima.push(...minima);
  }

  console.log(`找到 ${allMinima.length} 个候选最小值点`);
  // 聚类半径并过滤 (容差10像素)
  const clusteredRings = clusterRadii(allMinima, 10, numAngles);

  console.log(`聚类后得到 ${clusteredRings.length} 个暗环`);
  // 提取每个暗环的完整信息 (关键点、椭圆拟合)
  for (const ringRadius of clusteredRings) {
    const ringData = extractRingData(grayMat, centerX, centerY, ringRadius);
    if (ringData) {
      rings.push(ringData);
    }
  }
  // 排序并编号
  return sortRings(rings);
}

// 查找径向剖面中的局部最小值
function findLocalMinima(profile) {
  const minima = [];
  const windowSize = 5;

  for (let i = windowSize; i < profile.length - windowSize; i++) {
    const current = profile[i].intensity;
    let isMin = true;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j !== i && profile[j].intensity < current) {
        isMin = false;
        break;
      }
    }
    // 检查对比度 (与周围平均值比较)
    if (isMin) {
      const leftAvg = profile.slice(Math.max(0, i - 10), i).reduce((sum, p) => sum + p.intensity, 0) / Math.min(10, i);
      const rightAvg = profile.slice(i + 1, Math.min(profile.length, i + 11)).reduce((sum, p) => sum + p.intensity, 0) / Math.min(10, profile.length - i - 1);
      const avgSurrounding = (leftAvg + rightAvg) / 2;
      const contrast = avgSurrounding - current;
      // 对比度阈值：至少8个灰度级
      if (contrast > 8) {
        minima.push({ ...profile[i], contrast });
        i += 6; // 非极大值抑制，跳过附近点
      }
    }
  }

  return minima;
}

// 聚类半径并过滤
function clusterRadii(minima, tolerance, numAngles) {
  if (minima.length === 0) return [];

  minima.sort((a, b) => a.radius - b.radius);
  // 聚类相近的半径
  const clusters = [];
  let currentCluster = [minima[0]];

  for (let i = 1; i < minima.length; i++) {
    const prevAvgRadius = currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length;
    const currRadius = minima[i].radius;

    if (currRadius - prevAvgRadius <= tolerance) {
      currentCluster.push(minima[i]);
    } else {
      const avgRadius = currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length;
      const count = currentCluster.length;
      clusters.push({ radius: avgRadius, count });
      currentCluster = [minima[i]];
    }
  }
  // 处理最后一个聚类
  if (currentCluster.length > 0) {
    const avgRadius = currentCluster.reduce((sum, m) => sum + m.radius, 0) / currentCluster.length;
    const count = currentCluster.length;
    clusters.push({ radius: avgRadius, count });
  }
  // 过滤：至少33%角度出现，且半径>=15像素
  const minOccurrences = Math.ceil(numAngles / 3);
  const minRadius = 15;
  const filteredClusters = clusters
    .filter(c => c.count >= minOccurrences && c.radius >= minRadius)
    .map(c => c.radius);

  console.log(`过滤后暗环: ${filteredClusters.length} 个 (最小出现次数: ${minOccurrences})`);

  return filteredClusters;
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
    const keyPoints = findKeyPoints(points, centerX, centerY);

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
