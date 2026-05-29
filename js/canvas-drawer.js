import { RING_COLOR } from './constants.js';

// 清空 Canvas 画布
export function clearCanvas(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// 绘制检测结果到 Canvas
export function drawDetectionResults(canvasRef, imageManager) {
    const canvas = canvasRef.value;
    if (!canvas) return;
    const currentData = imageManager.getCurrentImageData();
    if (!currentData || !currentData.detectedRings) return;
    const ctx = canvas.getContext('2d');
    const { originalWidth: imgWidth, originalHeight: imgHeight } = currentData;
    const rings = currentData.detectedRings;
    // Canvas 尺寸设置为原始图像尺寸，与坐标系统一致
    canvas.width = imgWidth;
    canvas.height = imgHeight;
    clearCanvas(canvas);

    if (rings && rings.length > 0) {
        drawOverlay(ctx, rings, null);
    }
}

// 绘制暗环覆盖层 (包括中心十字、轮廓、标签)
export function drawOverlay(ctx, rings, hoveredRing) {
    if (!rings || rings.length === 0) return;
    const hasHover = hoveredRing !== null;
    // 计算所有暗环的中心点
    const centerX = rings.reduce((sum, r) => sum + r.x, 0) / rings.length;
    const centerY = rings.reduce((sum, r) => sum + r.y, 0) / rings.length;
    ctx.strokeStyle = `rgba(${RING_COLOR}, ${hasHover && hoveredRing ? 1 : 0.5})`;
    ctx.lineWidth = 2;
    const crossSize = 20;
    ctx.beginPath();
    ctx.moveTo(centerX - crossSize, centerY);
    ctx.lineTo(centerX + crossSize, centerY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - crossSize);
    ctx.lineTo(centerX, centerY + crossSize);
    ctx.stroke();
    // 绘制每个暗环
    rings.forEach((ring) => {
        const isHovered = hoveredRing === ring.number;
        const opacity = isHovered ? 1 : 0.7;
        if (ring.contour) {
            drawContour(ctx, ring, isHovered, opacity);
        } else if (ring.ellipse) {
            drawEllipse(ctx, ring, isHovered, opacity);
        } else if (ring.keyPoints) {
            drawKeyPointsShape(ctx, ring, isHovered, opacity);
        } else {
            ctx.strokeStyle = `rgba(${RING_COLOR}, ${opacity})`;
            ctx.lineWidth = isHovered ? 3 : 2;
            ctx.beginPath();
            ctx.arc(ring.x, ring.y, ring.avgRadius, 0, Math.PI * 2);
            ctx.stroke();
        }
        // 悬停时只显示当前环的标签
        if (!hasHover || isHovered) {
            drawLabel(ctx, ring, isHovered, opacity);
        }
    });
}

// 绘制完整轮廓 (从 contour 数据)
function drawContour(ctx, ring, isHovered, opacity) {
    ctx.strokeStyle = `rgba(${RING_COLOR}, ${opacity})`;
    ctx.lineWidth = isHovered ? 3 : 2;
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
function drawEllipse(ctx, ring, isHovered, opacity) {
    const { center, size, angle } = ring.ellipse;
    ctx.strokeStyle = `rgba(${RING_COLOR}, ${opacity})`;
    ctx.lineWidth = isHovered ? 3 : 2;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(angle * Math.PI / 180);
    ctx.beginPath();
    ctx.ellipse(0, 0, size.width / 2, size.height / 2, 0, 0, Math.PI * 2);
    ctx.restore();
    ctx.stroke();
}

// 绘制关键点连线形状 (上下左右4点构成的四边形)
function drawKeyPointsShape(ctx, ring, isHovered, opacity) {
    const { top, bottom, left, right } = ring.keyPoints;
    ctx.strokeStyle = `rgba(${RING_COLOR}, ${opacity})`;
    ctx.lineWidth = isHovered ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.stroke();
    // 标记4个关键点
    ctx.fillStyle = `rgba(${RING_COLOR}, ${opacity})`;
    [top, bottom, left, right].forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });
}

// 绘制环编号标签 (位于环的左上角)
function drawLabel(ctx, ring, isHovered, opacity) {
    const angle = -Math.PI / 4;
    const labelX = ring.x + ring.avgRadius * Math.cos(angle);
    const labelY = ring.y + ring.avgRadius * Math.sin(angle);
    ctx.font = `${isHovered ? 'bold' : ''} 12px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = ring.number.toString();
    const textMetrics = ctx.measureText(text);
    const padding = 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(
        labelX - textMetrics.width / 2 - padding,
        labelY - 6 - padding,
        textMetrics.width + padding * 2,
        12 + padding * 2
    );
    ctx.fillStyle = `rgba(${RING_COLOR}, ${opacity})`;
    ctx.fillText(text, labelX, labelY);
}
