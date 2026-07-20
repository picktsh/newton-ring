// @ts-ignore
/* global Vue, cv */

import { createImageManager } from './image-manager.js';
import { processNewtonRings } from './image-processor.js';
import { initCanvasInteraction, onTableRowHover, onTableRowLeave, initDragDrop } from './interaction-handler.js';
import { calculateDiameterData, calculateRadiusData, calculateAverageRadius, generateCalculationResults } from './data-calculator.js';
import { drawDetectionResults, clearCanvas } from './canvas-drawer.js';

const { ref, reactive, computed, onMounted, nextTick, watch } = Vue;

// Vue 应用主组件
export default {
    setup() {
        const imageManager = createImageManager();

        const cvReady = ref(false);
        const pixelScale = ref(0.005);
        const logs = ref([]);
        const isProcessing = ref(false);
        const hoveredRingRef = ref(null);
        // 当前活动标签页 (从 sessionStorage 恢复)
        const activeTab = ref(sessionStorage.getItem('activeTab') || 'rings');
        // 监听 tab 切换，持久化到 sessionStorage
        watch(activeTab, (val) => { sessionStorage.setItem('activeTab', val); });
        // ===== 像素标定状态 =====
        // ===== 像素标定 sessionStorage 缓存 =====
        const CALIB_KEY = 'calib_images';
        const CALIB_POINT_KEY = 'calib_points';

        function saveCalibToSession() {
            try {
                const data = {
                    imageA: calibImageA.value ? { src: calibImageA.value.src, name: calibImageA.value.name, width: calibImageA.value.width, height: calibImageA.value.height } : null,
                    imageB: calibImageB.value ? { src: calibImageB.value.src, name: calibImageB.value.name, width: calibImageB.value.width, height: calibImageB.value.height } : null,
                    scaleA: calibScaleA.value,
                    scaleB: calibScaleB.value,
                    distanceManual: calibDistanceManual.value
                };
                sessionStorage.setItem(CALIB_KEY, JSON.stringify(data));
                const points = {
                    pointA: calibPointA.value,
                    pointB: calibPointB.value,
                    activeSlot: calibActiveSlot.value
                };
                sessionStorage.setItem(CALIB_POINT_KEY, JSON.stringify(points));
            } catch (e) { console.warn('标定缓存保存失败:', e); }
        }

        function loadCalibFromSession() {
            try {
                const raw = sessionStorage.getItem(CALIB_KEY);
                if (raw) {
                    const data = JSON.parse(raw);
                    calibImageA.value = data.imageA || null;
                    calibImageB.value = data.imageB || null;
                    calibScaleA.value = data.scaleA ?? null;
                    calibScaleB.value = data.scaleB ?? null;
                    calibDistanceManual.value = data.distanceManual ?? null;
                }
                const rawPoints = sessionStorage.getItem(CALIB_POINT_KEY);
                if (rawPoints) {
                    const pts = JSON.parse(rawPoints);
                    calibPointA.value = pts.pointA || null;
                    calibPointB.value = pts.pointB || null;
                    calibActiveSlot.value = pts.activeSlot || 'A';
                }
            } catch (e) { console.warn('标定缓存加载失败:', e); }
        }

        const calibImageA = ref(null);  // { src, name, width, height }
        const calibImageB = ref(null);
        const calibPointA = ref(null);  // { x, y } 像素坐标
        const calibPointB = ref(null);
        const calibActiveSlot = ref('A');  // 当前键盘微调的目标图片
        const calibScaleA = ref(null);       // 图A对应鼓轮刻度 (mm)
        const calibScaleB = ref(null);       // 图B对应鼓轮刻度 (mm)
        const calibDistanceManual = ref(null); // 手动输入的实际距离 (mm)，优先于自动差值
        const calibFileInputA = ref(null);
        const calibFileInputB = ref(null);
        const calibCanvasA = ref(null);
        const calibCanvasB = ref(null);

        // 自动差值 (由刻度差计算)
        const calibAutoDistance = computed(() => {
            if (calibScaleA.value == null || calibScaleB.value == null) return 0;
            return Math.abs(calibScaleA.value - calibScaleB.value);
        });
        // 最终使用的物理距离: 手动优先，否则自动差值
        const calibPhysicalDistance = computed(() => {
            if (calibDistanceManual.value != null && calibDistanceManual.value > 0) return calibDistanceManual.value;
            return calibAutoDistance.value;
        });

        // 刻度变化时，自动将差值同步到距离输入框
        watch(calibAutoDistance, (newVal) => {
            if (newVal > 0) {
                calibDistanceManual.value = Math.round(newVal * 1000) / 1000; // 保留3位小数
            }
        });

        // 监听标定数据变化，自动缓存
        watch([calibImageA, calibImageB, calibPointA, calibPointB, calibScaleA, calibScaleB, calibDistanceManual], () => {
            saveCalibToSession();
        });
        const initState = {
            // 获取滤镜参数初始值
            filterParams: ()=>({
                brightness: 1.0,
                contrast: 1.0,
                blur: 0,
                grayscale: 0,
                sharpen: 0,
                edgeEnhance: 0,
                claheClip: 2.0,
                claheTile: 8
            })
        }
        const filterParams = reactive(initState.filterParams());
        // CSS滤镜预览样式 (响应式计算)
        const previewFilterStyle = computed(() => {
            const filters = [];
            if (filterParams.brightness !== 1.0) filters.push(`brightness(${filterParams.brightness})`);
            if (filterParams.contrast !== 1.0) filters.push(`contrast(${filterParams.contrast})`);
            if (filterParams.blur > 0) filters.push(`blur(${filterParams.blur}px)`);
            if (filterParams.grayscale > 0) filters.push(`grayscale(${filterParams.grayscale}%)`);
            if (filterParams.sharpen > 0) {
                updateSharpenFilter(filterParams.sharpen);
                filters.push('url(#sharpenFilter)');
            }
            if (filterParams.edgeEnhance > 0) {
                updateEdgeEnhanceFilter(filterParams.edgeEnhance);
                filters.push('url(#edgeEnhanceFilter)');
            }
            return filters.join(' ') || 'none';
        });

        const originalImageRef = ref(null);
        const resultCanvasRef = ref(null);
        const resultImageRef = ref(null);
        const fileInputRef = ref(null);
        const logContainerRef = ref(null);
        const resultImageSrcRef = ref('');
        // 当前选中的图片数据
        const currentImageData = computed(() => {
            return imageManager.getCurrentImageData();
        });
        // 原始图像展示 URL
        const originalImageSrcRef = computed(() => {
            return imageManager.getOriginalImageSrc();
        });
        // 直径测量数据
        const diameterData = computed(() => {
            const rings = currentImageData.value?.detectedRings || [];
            return calculateDiameterData(rings, pixelScale.value);
        });
        // 曲率半径计算结果
        const radiusData = computed(() => {
            const rings = currentImageData.value?.detectedRings || [];
            return calculateRadiusData(rings, pixelScale.value);
        });
        // 平均曲率半径
        const averageRadius = computed(() => {
            return calculateAverageRadius(radiusData.value);
        });
        // 完整的计算结果对象
        const calculationResults = computed(() => {
            return generateCalculationResults(
                diameterData.value,
                radiusData.value,
                averageRadius.value,
                pixelScale.value
            );
        });

        function showStatus(message, type = 'info') {
            logs.value.push({ message, type });
            if (logs.value.length > 20) logs.value.shift();
            nextTick(() => scrollToBottom());
        }

        function scrollToBottom() {
            const container = logContainerRef.value;
            if (container) container.scrollTop = container.scrollHeight;
        }

        // ===== 像素标定计算 =====
        const calibDeltaX = computed(() => {
            if (!calibPointA.value || !calibPointB.value) return 0;
            return Math.abs(calibPointA.value.x - calibPointB.value.x);
        });
        const calibDeltaY = computed(() => {
            if (!calibPointA.value || !calibPointB.value) return 0;
            return Math.abs(calibPointA.value.y - calibPointB.value.y);
        });
        const calibPixelDistance = computed(() => {
            return Math.sqrt(calibDeltaX.value ** 2 + calibDeltaY.value ** 2);
        });
        const calibValue = computed(() => {
            if (calibPixelDistance.value <= 0 || calibPhysicalDistance.value <= 0) return 0;
            return calibPhysicalDistance.value / calibPixelDistance.value;
        });

        // 标定图片上传处理
        function handleCalibUpload(event, slot) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const data = { src: e.target.result, name: file.name, width: img.naturalWidth, height: img.naturalHeight };
                    if (slot === 'A') {
                        calibImageA.value = data;
                        calibPointA.value = null;
                    } else {
                        calibImageB.value = data;
                        calibPointB.value = null;
                    }
                    nextTick(() => drawCalibCanvas(slot));
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
        function handleCalibUploadA(e) { handleCalibUpload(e, 'A'); }
        function handleCalibUploadB(e) { handleCalibUpload(e, 'B'); }

        // 点击选点
        function onCalibClick(slot, event) {
            const container = event.currentTarget;
            const img = container.querySelector('img');
            if (!img) return;
            calibActiveSlot.value = slot;  // 点击时自动设为当前微调目标
            const rect = container.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const clickY = event.clientY - rect.top;
            // 将显示坐标转换为原始像素坐标
            const scaleX = (slot === 'A' ? calibImageA.value.width : calibImageB.value.width) / img.clientWidth;
            const scaleY = (slot === 'A' ? calibImageA.value.height : calibImageB.value.height) / img.clientHeight;
            const px = Math.round(clickX * scaleX);
            const py = Math.round(clickY * scaleY);
            if (slot === 'A') {
                calibPointA.value = { x: px, y: py };
            } else {
                calibPointB.value = { x: px, y: py };
            }
            nextTick(() => drawCalibCanvas(slot));
        }
        function onCalibClickA(e) { onCalibClick('A', e); }
        function onCalibClickB(e) { onCalibClick('B', e); }

        // 键盘方向键微调标记点
        function onCalibKeydown(e) {
            const slot = calibActiveSlot.value;
            const point = slot === 'A' ? calibPointA.value : calibPointB.value;
            if (!point) return;
            const step = e.shiftKey ? 5 : 1;
            let dx = 0, dy = 0;
            switch (e.key) {
                case 'ArrowUp': dy = -step; break;
                case 'ArrowDown': dy = step; break;
                case 'ArrowLeft': dx = -step; break;
                case 'ArrowRight': dx = step; break;
                default: return;
            }
            e.preventDefault();
            const imgData = slot === 'A' ? calibImageA.value : calibImageB.value;
            if (!imgData) return;
            const newX = Math.max(0, Math.min(imgData.width - 1, point.x + dx));
            const newY = Math.max(0, Math.min(imgData.height - 1, point.y + dy));
            if (slot === 'A') {
                calibPointA.value = { x: newX, y: newY };
            } else {
                calibPointB.value = { x: newX, y: newY };
            }
            nextTick(() => drawCalibCanvas(slot));
        }

        // 绘制标定画布 (精细十字标记)
        function drawCalibCanvas(slot) {
            const canvas = slot === 'A' ? calibCanvasA.value : calibCanvasB.value;
            const imgEl = canvas?.parentElement?.querySelector('img');
            if (!canvas || !imgEl) return;
            canvas.width = imgEl.clientWidth;
            canvas.height = imgEl.clientHeight;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const point = slot === 'A' ? calibPointA.value : calibPointB.value;
            const imgData = slot === 'A' ? calibImageA.value : calibImageB.value;
            if (!point || !imgData) return;
            // 像素坐标 → 显示坐标
            const displayX = point.x * imgEl.clientWidth / imgData.width;
            const displayY = point.y * imgEl.clientHeight / imgData.height;
            const color = slot === 'A' ? '#667eea' : '#764ba2';
            // 画长十字线（贯穿整个图片，细线）
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.4;
            ctx.beginPath();
            ctx.moveTo(0, displayY);
            ctx.lineTo(canvas.width, displayY);
            ctx.moveTo(displayX, 0);
            ctx.lineTo(displayX, canvas.height);
            ctx.stroke();
            ctx.globalAlpha = 1;
            // 画中心精细十字（短而细）
            ctx.lineWidth = 1;
            ctx.strokeStyle = color;
            const gap = 4;  // 中心留空
            const arm = 18; // 臂长
            ctx.beginPath();
            ctx.moveTo(displayX - arm, displayY);
            ctx.lineTo(displayX - gap, displayY);
            ctx.moveTo(displayX + gap, displayY);
            ctx.lineTo(displayX + arm, displayY);
            ctx.moveTo(displayX, displayY - arm);
            ctx.lineTo(displayX, displayY - gap);
            ctx.moveTo(displayX, displayY + gap);
            ctx.lineTo(displayX, displayY + arm);
            ctx.stroke();
            // 画小圆点
            ctx.beginPath();
            ctx.arc(displayX, displayY, 2, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            // 标注坐标
            ctx.fillStyle = color;
            ctx.font = '11px monospace';
            ctx.fillText(`(${point.x}, ${point.y})`, displayX + 10, displayY - 8);
        }

        // 删除单张标定图片
        function removeCalibImage(slot) {
            if (slot === 'A') {
                calibImageA.value = null;
                calibPointA.value = null;
            } else {
                calibImageB.value = null;
                calibPointB.value = null;
            }
            saveCalibToSession();
        }

        // 重置标定
        function resetCalibration() {
            calibImageA.value = null;
            calibImageB.value = null;
            calibPointA.value = null;
            calibPointB.value = null;
            calibScaleA.value = null;
            calibScaleB.value = null;
            calibDistanceManual.value = null;
            sessionStorage.removeItem(CALIB_KEY);
            sessionStorage.removeItem(CALIB_POINT_KEY);
        }

        // 应用标定值到牛顿环识别
        function applyCalibration() {
            if (calibValue.value > 0) {
                pixelScale.value = calibValue.value;
                activeTab.value = 'rings';
                showStatus(`✅ 标定值已应用: ${calibValue.value.toFixed(6)} mm/像素`, 'success');
            }
        }

        // 上传文件处理 (支持多选)
        async function handleFileUpload(event) {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;
            // 重置 input 以便重复选择同一文件
            event.target.value = '';
            await loadMultipleFiles(files);
        }

        // 批量加载图片文件
        async function loadMultipleFiles(files) {
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length === 0) {
                return showStatus(' 未找到有效图片文件', 'error');
            }
            showStatus(` 正在加载 ${imageFiles.length} 张图片...`, 'info');
            // 依次加载所有图片（只加载不处理）
            for (let i = 0; i < imageFiles.length; i++) {
                const file = imageFiles[i];
                await new Promise(resolve => {
                    imageManager.loadImageFile(file, (resultData, isCached) => {
                        if (isCached && resultData) {
                            showStatus(`✅ 已加载缓存: ${file.name}`, 'success');
                        } else {
                            showStatus(`✅ 已加载: ${file.name}`, 'success');
                        }
                        resolve();
                    });
                });
            }
            // 加载完成后，切换到最后一张并自动处理
            const lastFile = imageFiles[imageFiles.length - 1];
            showStatus(`🔄 开始处理: ${lastFile.name}`, 'info');
            setTimeout(() => processImage(), 300);
        }

        // OpenCV 图像处理主函数
        async function processImage() {
            if (!imageManager.uploadedImage.value || !cvReady.value) {
                return showStatus('❌ 请先上传图像并等待 OpenCV 加载', 'error');
            }
            if (isProcessing.value) {
                return showStatus('⏳ 正在处理中，请稍候...', 'info');
            }

            isProcessing.value = true;
            try {
                // 清空上次检测结果
                resultImageSrcRef.value = null;
                clearCanvas(resultCanvasRef.value);
                const fingerprint = imageManager.currentFingerprint.value;
                if (fingerprint) {
                    sessionStorage.removeItem('calc_' + fingerprint);
                }
                // 调用图像处理核心函数
                await processNewtonRings(
                    imageManager,
                    showStatus,
                    filterParams,
                    resultImageRef
                );
                // 处理完成后，绘制结果和初始化交互
                nextTick(() => {
                    drawDetectionResults(resultCanvasRef, imageManager);
                    initCanvasInteractionWrapper();
                    resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                });
            } catch (error) {
                console.error('处理错误:', error);
                showStatus(`❌ 处理失败: ${error.message}`, 'error');
                resultImageSrcRef.value = imageManager.getOriginalImageSrc();
            } finally {
                isProcessing.value = false;
            }
        }

        // Canvas交互包装函数
        function initCanvasInteractionWrapper() {
            initCanvasInteraction(resultImageRef, resultCanvasRef, imageManager, hoveredRingRef);
        }

        // 从缓存恢复显示
        function restoreFromCache(resultData) {
            drawDetectionResults(resultCanvasRef, imageManager);
            nextTick(() => initCanvasInteractionWrapper());
        }

        // 表格行悬停处理
        function handleTableRowHover(ringNumber) {
            onTableRowHover(ringNumber, resultCanvasRef, imageManager, hoveredRingRef);
        }

        function handleTableRowLeave() {
            onTableRowLeave(resultCanvasRef, imageManager, hoveredRingRef);
        }

        // 图片切换处理
        function handleSwitchToImage(fingerprint) {
            imageManager.switchToImage(fingerprint, (resultData) => {
                resultImageSrcRef.value = imageManager.getOriginalImageSrc();

                if (resultData?.detectedRings?.length > 0) {
                    showStatus(`✅ 已切换: ${imageManager.processedImages.value.find(p => p.fingerprint === fingerprint)?.fileName || '未知'}`, 'success');
                    nextTick(() => restoreFromCache(resultData));
                } else {
                    showStatus(`⚠️ 该图片尚未处理，自动检测中...`, 'info');
                    clearCanvas(resultCanvasRef.value);
                    nextTick(() => {
                        setTimeout(() => processImage(), 300);
                    });
                }
            });
        }

        // 删除图片处理
        function handleRemoveFromProcessedList(fingerprint) {
            if (imageManager.currentFingerprint.value === fingerprint) {
                clearCanvas(resultCanvasRef.value);
                resultImageSrcRef.value = null;
            }

            imageManager.removeFromProcessedList(fingerprint, (resultData) => {
                if (resultData === null) {
                    showStatus('✅ 已删除', 'success');
                    clearCanvas(resultCanvasRef.value);
                    resultImageSrcRef.value = null;
                } else if (resultData?.detectedRings?.length > 0) {
                    showStatus('✅ 已删除，已切换到下一张', 'success');
                    resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                    nextTick(() => restoreFromCache(resultData));
                } else {
                    showStatus('✅ 已删除，自动检测新图片...', 'info');
                    clearCanvas(resultCanvasRef.value);
                    nextTick(() => {
                        setTimeout(() => processImage(), 300);
                    });
                }
            });
        }

        // 重置滤镜参数为默认值
        function resetFilterParams() {
            Object.assign(filterParams, initState.filterParams());
            showStatus('✅ 参数已重置', 'info');
        }

        // 更新锐化滤镜 (动态修改 SVG filter 矩阵)
        function updateSharpenFilter(strength) {
            const matrix = document.getElementById('sharpenMatrix');
            if (!matrix) return;

            const s = strength;
            const center = 1 + 4 * s;
            const side = -s;

            matrix.setAttribute('kernelMatrix', `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
        }

        function updateEdgeEnhanceFilter(strength) {
            const matrix = document.getElementById('edgeEnhanceMatrix');
            if (!matrix) return;
            const s = strength;
            matrix.setAttribute('kernelMatrix', `${s} ${s} ${s} ${s} ${1+s*2} ${s} -${s} -${s} -${s}`);
        }

        function updatePreviewFilter() {
        }

        // 导出 CSV 数据
        function exportCSV() {
            if (!calculationResults.value) {
                showStatus('❌ 暂无数据可导出', 'error');
                return;
            }
            const { diameterData, radiusData, averageR, pixelScale, timestamp } = calculationResults.value;
            let csv = '\uFEFF';
            csv += '牛顿环实验测量结果\n';
            csv += `生成时间:,${timestamp}\n`;
            csv += `像素标定:,${pixelScale} mm/像素\n`;
            csv += `平均曲率半径:,${averageR.toFixed(3)} m\n\n`;
            csv += '表1: 各暗环直径测量数据\n';
            csv += '环编号 (k),直径 (像素),直径 (mm)\n';
            diameterData.forEach(item => {
                csv += `${item.number},${item.diameterPixel.toFixed(2)},${item.diameterMM.toFixed(3)}\n`;
            });
            csv += '\n表2: 曲率半径计算结果\n';
            csv += '分组,m,n,Dm² - Dn² (mm²),曲率半径 R (m)\n';
            radiusData.forEach(item => {
                csv += `${item.group},${item.m},${item.n},${item.diffSquared.toFixed(3)},${item.radius.toFixed(3)}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `牛顿环测量结果_${Date.now()}.csv`;
            link.click();
            showStatus('✅ CSV 文件已导出', 'success');
        }

        // 导出识别结果图片 (合并底图和标记层)
        function exportImage() {
            const canvas = resultCanvasRef.value;
            const img = resultImageRef.value;
            if (!canvas || canvas.width === 0 || !img) {
                showStatus('❌ 暂无识别结果', 'error');
                return;
            }
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = canvas.width;
            tempCanvas.height = canvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
            tempCtx.drawImage(canvas, 0, 0);
            const link = document.createElement('a');
            link.download = `牛顿环识别结果_${Date.now()}.png`;
            link.href = tempCanvas.toDataURL('image/png');
            link.click();
            showStatus('✅ 识别结果图片已导出', 'success');
        }

        // 初始化 OpenCV
        function initOpenCV() {
            if (typeof cv !== 'undefined') {
                if (cv.onRuntimeInitialized) {
                    cv.onRuntimeInitialized = () => {
                        cvReady.value = true;
                        showStatus('✅ OpenCV 已就绪，请上传或拖拽牛顿环图像', 'success');
                    };
                } else {
                    cvReady.value = true;
                    showStatus('✅ OpenCV 已就绪，请上传或拖拽牛顿环图像', 'success');
                }
            } else {
                setTimeout(initOpenCV, 500);
            }
        }

        onMounted(() => {
            imageManager.loadCacheFromSession((resultData) => {
                if (resultData?.detectedRings?.length > 0) {
                    resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                    nextTick(() => {
                        setTimeout(() => restoreFromCache(resultData), 100);
                    });
                }
            });

            initOpenCV();
            initDragDrop(loadMultipleFiles, () => activeTab.value === 'rings');
            // 键盘方向键微调标定标记
            document.addEventListener('keydown', onCalibKeydown);
            // 恢复标定图片缓存
            loadCalibFromSession();
            nextTick(() => {
                if (calibImageA.value) drawCalibCanvas('A');
                if (calibImageB.value) drawCalibCanvas('B');
            });
        });

        return {
            cvReady,
            pixelScale,
            logs,
            isProcessing,
            activeTab,
            processedImages: imageManager.processedImages,
            currentFingerprint: imageManager.currentFingerprint,
            filterParams,
            previewFilterStyle,

            originalImageRef,
            resultCanvasRef,
            resultImageRef,
            fileInputRef,
            logContainerRef,

            originalImageSrc: originalImageSrcRef,
            resultImageSrc: resultImageSrcRef,
            uploadedImage: imageManager.uploadedImage,

            diameterData,
            radiusData,
            averageRadius,
            calculationResults,
            hoveredRing: hoveredRingRef,

            // 像素标定
            calibImageA, calibImageB,
            calibPointA, calibPointB,
            calibScaleA, calibScaleB,
            calibDistanceManual,
            calibAutoDistance, calibPhysicalDistance,
            calibDeltaX, calibDeltaY, calibPixelDistance, calibValue,
            calibFileInputA, calibFileInputB,
            calibCanvasA, calibCanvasB,
            calibActiveSlot,
            handleCalibUploadA, handleCalibUploadB,
            onCalibClickA, onCalibClickB,
            removeCalibImage,
            resetCalibration, applyCalibration,

            handleFileUpload,
            processImage,
            switchToImage: handleSwitchToImage,
            removeFromProcessedList: handleRemoveFromProcessedList,
            exportCSV,
            exportImage,
            onTableRowHover: handleTableRowHover,
            onTableRowLeave: handleTableRowLeave,
            resetFilterParams,
            updatePreviewFilter
        };
    }
};
