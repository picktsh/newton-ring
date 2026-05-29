// @ts-ignore
/* global cv */

import { drawOverlay, clearCanvas } from './canvas-drawer.js';

// 初始化 Canvas 交互 (鼠标悬停检测暗环)
export function initCanvasInteraction(resultImageRef, resultCanvasRef, imageManager, hoveredRingRef) {
    const img = resultImageRef.value;
    const canvas = resultCanvasRef.value;
    if (!img || !canvas) return;

    img.addEventListener('mousemove', (e) => {
        const rect = img.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mouseX = (e.clientX - rect.left) * scaleX;
        const mouseY = (e.clientY - rect.top) * scaleY;
        const currentData = imageManager.getCurrentImageData();
        const rings = currentData?.detectedRings || [];
        if (rings.length === 0) return;
        // 检测鼠标是否悬停在某个暗环上
        let found = null;

        for (const ring of rings) {
            const dist = Math.sqrt(
                Math.pow(mouseX - ring.x, 2) +
                Math.pow(mouseY - ring.y, 2)
            );
            const tolerance = Math.max(8, ring.avgRadius * 0.05);
            if (Math.abs(dist - ring.avgRadius) < tolerance) {
                found = ring.number;
                break;
            }
        }
        // 如果悬停状态改变，重新绘制
        if (found !== hoveredRingRef.value) {
            hoveredRingRef.value = found;
            redrawOverlay(canvas, rings, hoveredRingRef.value);
        }
    });

    img.addEventListener('mouseleave', () => {
        hoveredRingRef.value = null;
        const currentData = imageManager.getCurrentImageData();
        const rings = currentData?.detectedRings || [];
        redrawOverlay(canvas, rings, null);
    });
}

// 表格行悬停时高亮对应暗环
export function onTableRowHover(ringNumber, resultCanvasRef, imageManager, hoveredRingRef) {
    hoveredRingRef.value = ringNumber;
    const canvas = resultCanvasRef.value;
    if (!canvas) return;
    const currentData = imageManager.getCurrentImageData();
    const rings = currentData?.detectedRings || [];
    if (rings.length > 0) {
        redrawOverlay(canvas, rings, hoveredRingRef.value);
    }
}

// 表格行离开时取消高亮
export function onTableRowLeave(resultCanvasRef, imageManager, hoveredRingRef) {
    hoveredRingRef.value = null;
    const canvas = resultCanvasRef.value;
    if (!canvas) return;
    const currentData = imageManager.getCurrentImageData();
    const rings = currentData?.detectedRings || [];
    if (rings.length > 0) {
        redrawOverlay(canvas, rings, null);
    }
}

// 重绘覆盖层
function redrawOverlay(canvas, rings, hoveredRing) {
    if (!canvas || !rings || rings.length === 0) return;
    clearCanvas(canvas);
    drawOverlay(canvas.getContext('2d'), rings, hoveredRing);
}

// 初始化拖拽上传功能
export function initDragDrop(loadImageFileCallback) {
    let dragCounter = 0;
    document.body.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        document.body.classList.add('drag-over');
    });
    document.body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter === 0) {
            document.body.classList.remove('drag-over');
        }
    });
    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    document.body.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        document.body.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type.startsWith('image/')) {
            await loadImageFileCallback(files[0]);
        } else {
            alert('❌ 请拖拽图片文件');
        }
    });
}
