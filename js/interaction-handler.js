// @ts-ignore
/* global cv */

import { drawOverlay, clearCanvas } from './canvas-drawer.js';

// 读取启用中的环 (人工取消勾选的环不参与交互联动；旧数据无 enabled 字段视为启用)
function getEnabledRings(imageManager) {
    const currentData = imageManager.getCurrentImageData();
    return (currentData?.detectedRings || []).filter(r => r.enabled !== false);
}

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
        const rings = getEnabledRings(imageManager);
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
        const rings = getEnabledRings(imageManager);
        redrawOverlay(canvas, rings, null);
    });
}

// 表格行悬停时高亮对应暗环
export function onTableRowHover(ringNumber, resultCanvasRef, imageManager, hoveredRingRef) {
    hoveredRingRef.value = ringNumber;
    const canvas = resultCanvasRef.value;
    if (!canvas) return;
    const rings = getEnabledRings(imageManager);
    if (rings.length > 0) {
        redrawOverlay(canvas, rings, hoveredRingRef.value);
    }
}

// 表格行离开时取消高亮
export function onTableRowLeave(resultCanvasRef, imageManager, hoveredRingRef) {
    hoveredRingRef.value = null;
    const canvas = resultCanvasRef.value;
    if (!canvas) return;
    const rings = getEnabledRings(imageManager);
    if (rings.length > 0) {
        redrawOverlay(canvas, rings, null);
    }
}

// 初始化圆心拖拽微调交互 (圆心确认阶段)
// 返回清理函数，用于阶段切换时移除监听与恢复光标
export function initCenterAdjustInteraction(resultImageRef, resultCanvasRef, onCenterChange) {
    const img = resultImageRef.value;
    const canvas = resultCanvasRef.value;
    if (!img || !canvas) return () => {};
    img.style.cursor = 'move';
    let dragging = false;

    const toImageCoords = (e) => {
        const rect = img.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        return {
            x: Math.max(0, Math.min(canvas.width - 1, x)),
            y: Math.max(0, Math.min(canvas.height - 1, y))
        };
    };

    const onMouseDown = (e) => {
        dragging = true;
        const { x, y } = toImageCoords(e);
        onCenterChange({ x: Math.round(x), y: Math.round(y) });
        e.preventDefault();
    };
    const onMouseMove = (e) => {
        if (!dragging) return;
        const { x, y } = toImageCoords(e);
        onCenterChange({ x: Math.round(x), y: Math.round(y) });
    };
    const onMouseUp = () => { dragging = false; };

    img.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
        img.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        img.style.cursor = '';
    };
}

// 重绘覆盖层
function redrawOverlay(canvas, rings, hoveredRing) {
    if (!canvas || !rings || rings.length === 0) return;
    clearCanvas(canvas);
    drawOverlay(canvas.getContext('2d'), rings, hoveredRing);
}

// 初始化拖拽上传功能
export function initDragDrop(loadImageFileCallback, shouldAccept) {
    let dragCounter = 0;
    document.body.addEventListener('dragenter', (e) => {
        e.preventDefault();
        // 只有当 shouldAccept 返回 true 时才显示拖拽提示
        if (shouldAccept && !shouldAccept()) return;
        dragCounter++;
        document.body.classList.add('drag-over');
    });
    document.body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (shouldAccept && !shouldAccept()) return;
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
        // 如果当前不在允许的区域，忽略
        if (shouldAccept && !shouldAccept()) return;
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length > 0) {
            await loadImageFileCallback(files);
        } else {
            alert('❌ 请拖拽图片文件');
        }
    });
}
