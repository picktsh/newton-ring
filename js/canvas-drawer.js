// 清空 Canvas 画布
export function clearCanvas(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// 绘制检测结果到 Canvas (未勾选的环不参与绘制)
export function drawDetectionResults(canvasRef, imageManager) {
    const canvas = canvasRef.value;
    if (!canvas) return;
    const currentData = imageManager.getCurrentImageData();
    if (!currentData || !currentData.detectedRings) return;
    const ctx = canvas.getContext('2d');
    const { originalWidth: imgWidth, originalHeight: imgHeight } = currentData;
    // 人工取消勾选的环 (enabled === false) 不绘制；旧数据无 enabled 字段视为启用
    const rings = currentData.detectedRings.filter(r => r.enabled !== false);
    // Canvas 尺寸设置为原始图像尺寸，与坐标系统一致
    canvas.width = imgWidth;
    canvas.height = imgHeight;
    clearCanvas(canvas);

    if (rings && rings.length > 0) {
        drawOverlay(ctx, rings, null);
    }
}

// 绘制圆心确认覆盖层 (圆心微调阶段：贯穿辅助线 + 十字 + 小圆 + 坐标标注；arm 为十字臂长，可用 +/- 键调节)
export function drawCenterOverlay(canvasRef, center, width, height, arm = 24) {
    const canvas = canvasRef.value;
    if (!canvas || !center) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const { x, y } = center;
    // 贯穿全图的橙色辅助线 (低透明度，便于判断圆心是否在各环中心)
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    // 中心十字 + 小圆 (臂长 arm 可调，便于对准不同尺寸的最内圈；亮绿色更醒目)
    const CURSOR_COLOR = 'rgba(0, 230, 118, 1)'; // #00E676 亮绿色
    ctx.strokeStyle = CURSOR_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    // 过十字四端点的虚线圆 (半径 = 臂长，随 +/- 键放大缩小，便于判断光标是否贴合最内圈)
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(x, y, arm, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 坐标标注 (带黑色描边便于辨认)
    ctx.font = 'bold 13px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const text = `圆心 (${Math.round(x)}, ${Math.round(y)})`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(text, x + 10, y - 8);
    ctx.fillStyle = CURSOR_COLOR;
    ctx.fillText(text, x + 10, y - 8);
}

// 绘制暗环覆盖层 (包括中心十字、轮廓、标签)
// unit: 线宽/字号/虚线间隔/关键点半径的补偿系数，默认 1 (主视图直接绘制)。
//       全屏放大弹窗用 ctx.setTransform(scale,...) 把绘制坐标缩放到原图像素空间，
//       传 1/scale 可让标记保持恒定屏幕粗细而不被 scale 放大。
export function drawOverlay(ctx, rings, hoveredRing, unit = 1) {
    if (!rings || rings.length === 0) return;
    const hasHover = hoveredRing !== null;
    // 计算所有暗环的中心点
    const centerX = rings.reduce((sum, r) => sum + r.x, 0) / rings.length;
    const centerY = rings.reduce((sum, r) => sum + r.y, 0) / rings.length;
    // 环彩色渐变: rings 已按半径升序(内→外)，按可见序号把色相从 0°(红) 线性铺到 280°(蓝紫)，
    // 每圈颜色不同; 单环取红(避免除零)。亮度 L=60% 提亮、满不透明(alpha=1)，肉眼更醒目。
    const N = rings.length;
    const ringColorAt = (i, alpha) => {
        const hue = N > 1 ? Math.round(280 * i / (N - 1)) : 0;
        return `hsla(${hue}, 100%, 60%, ${alpha})`;
    };
    // 中心十字: 白+深描边(先黑后白)，在牛顿环较亮的中心也始终清晰 (不再用绿色)
    const crossSize = 20 * unit;
    const strokeCross = () => {
        ctx.beginPath();
        ctx.moveTo(centerX - crossSize, centerY);
        ctx.lineTo(centerX + crossSize, centerY);
        ctx.moveTo(centerX, centerY - crossSize);
        ctx.lineTo(centerX, centerY + crossSize);
        ctx.stroke();
    };
    ctx.lineWidth = 4 * unit; ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'; strokeCross();
    ctx.lineWidth = 2 * unit; ctx.strokeStyle = `rgba(255, 255, 255, ${hasHover && hoveredRing ? 1 : 0.9})`; strokeCross();
    // 绘制每个暗环 (轮廓/编号标签/关键点均取该环渐变色)
    rings.forEach((ring, i) => {
        const isHovered = hoveredRing === ring.number;
        const color = ringColorAt(i, 1);   // 满不透明: 常态即最亮，悬停靠更粗线宽+标签加粗区分
        // 人工补入的环画虚线 (自动识别的环实线): 虚线专属于人工产物，一眼分辨哪圈是自己补的，
        // 也避免在同一半径上重复补环; 颜色仍按半径序取渐变，不破坏「内红→外紫」的序号对应
        ctx.setLineDash(ring.manual ? [10 * unit, 6 * unit] : []);
        if (ring.contour) {
            drawContour(ctx, ring, color, isHovered, unit);
        } else if (ring.ellipse) {
            drawEllipse(ctx, ring, color, isHovered, unit);
        } else if (ring.keyPoints) {
            drawKeyPointsShape(ctx, ring, color, isHovered, unit);
        } else {
            ctx.strokeStyle = color;
            ctx.lineWidth = (isHovered ? 3.5 : 2.5) * unit;
            ctx.beginPath();
            ctx.arc(ring.x, ring.y, ring.avgRadius, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        // 悬停时只显示当前环的标签 (序号统一白字黑底，不随环渐变色)
        if (!hasHover || isHovered) {
            drawLabel(ctx, ring, isHovered, unit);
        }
    });
}

// 绘制完整轮廓 (从 contour 数据)
function drawContour(ctx, ring, color, isHovered, unit = 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = (isHovered ? 3.5 : 2.5) * unit;
    ctx.beginPath();
    const points = ring.contour?.data32S;
    if (!points || points.length === 0) return;
    for (let i = 0; i < points.length; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.closePath();
    ctx.stroke();
}

// 绘制椭圆 (从 ellipse 数据)
function drawEllipse(ctx, ring, color, isHovered, unit = 1) {
    const { center, size, angle } = ring.ellipse;
    ctx.strokeStyle = color;
    ctx.lineWidth = (isHovered ? 3.5 : 2.5) * unit;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(angle * Math.PI / 180);
    ctx.beginPath();
    ctx.ellipse(0, 0, size.width / 2, size.height / 2, 0, 0, Math.PI * 2);
    ctx.restore();
    ctx.stroke();
}

// 绘制关键点连线形状 (上下左右4点构成的四边形)
function drawKeyPointsShape(ctx, ring, color, isHovered, unit = 1) {
    const { top, bottom, left, right } = ring.keyPoints;
    ctx.strokeStyle = color;
    ctx.lineWidth = (isHovered ? 3.5 : 2.5) * unit;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.stroke();
    // 标记4个关键点
    ctx.fillStyle = color;
    [top, bottom, left, right].forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3 * unit, 0, Math.PI * 2);
        ctx.fill();
    });
}

// 绘制环编号标签 (位于环的左上角)：序号统一白字 + 不透明黑底，与彩色环解耦，高对比、肉眼易读
function drawLabel(ctx, ring, isHovered, unit = 1) {
    const angle = -Math.PI / 4;
    const labelX = ring.x + ring.avgRadius * Math.cos(angle);
    const labelY = ring.y + ring.avgRadius * Math.sin(angle);
    const fontSize = 15 * unit;   // 略放大 (原 12px)，肉眼更好认
    const padding = 3 * unit;
    ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = ring.number.toString();
    const textMetrics = ctx.measureText(text);
    // 底色: 不透明黑 (0.85)，尺寸随字号自适应 (不再写死 12px 高，避免大字被裁)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(
        labelX - textMetrics.width / 2 - padding,
        labelY - fontSize / 2 - padding,
        textMetrics.width + padding * 2,
        fontSize + padding * 2
    );
    // 序号统一白色 (不随环渐变色)
    ctx.fillStyle = '#fff';
    ctx.fillText(text, labelX, labelY);
}
