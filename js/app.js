// @ts-ignore
/* global Vue, cv */

import { createImageManager } from './image-manager.js';
import { detectNewtonRingCenter, detectRingsWithCenter, mergeAndNumberRings, extractRingDataForManual } from './image-processor.js';
import { initCanvasInteraction, onTableRowHover, onTableRowLeave, initDragDrop, initCenterAdjustInteraction } from './interaction-handler.js';
import { calculateDiameterData, calculateRadiusData, calculateAverageRadius, generateCalculationResults } from './data-calculator.js';
import { drawDetectionResults, clearCanvas, drawCenterOverlay } from './canvas-drawer.js';

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
        // ===== 两步确认流程状态 =====
        // 'idle' 未开始 | 'awaiting-center' 待确认圆心 | 'done' 已识别环 (进入人工核对)
        const centerPhase = ref('idle');
        const detectedCenter = ref(null);          // { x, y } 当前圆心 (可人工微调)
        const centerCrossArm = ref(24);            // 圆心十字光标臂长 (px)，可用 +/- 键调节，范围 8~200
        const centerProcessedDataUrl = ref(null);  // 第一步预处理图缓存 (供识别环/补环复用)
        const detectedOuterRadius = ref(0);        // 外边界半径 (环搜索上限)
        let cleanupCenterAdjust = null;            // 圆心拖拽交互清理函数
        // 当前选中的图片数据
        const currentImageData = computed(() => {
            return imageManager.getCurrentImageData();
        });
        // 原始图像展示 URL
        const originalImageSrcRef = computed(() => {
            return imageManager.getOriginalImageSrc();
        });
        // ===== 环人工核对：默认全部勾选，可取消勾选去除、可改编号 =====
        // 映射副本：旧数据无 enabled 字段视为启用 (默认全选)
        const ringList = computed(() => {
            const rings = currentImageData.value?.detectedRings || [];
            return rings.map(r => ({ ...r, enabled: r.enabled !== false }));
        });
        const enabledRings = computed(() => ringList.value.filter(r => r.enabled));
        const manualRingCount = computed(() => ringList.value.filter(r => r.manual).length);
        // 取消勾选后的编号策略：默认 false = 保持原编号；true = 启用环按半径顺延重排 1..N (会话内保留)
        const renumberOnRemove = ref(false);
        // 逐差法步长 (m-n)：默认 3，可人工修改；组件级状态，切换图片保留，刷新页面恢复默认 (会话内保留)
        const diffStep = ref(3);
        // 步长输入校验：须为不小于 1 的整数，非法值还原为 3 并提示 (响应式自动重算表2)
        function onDiffStepChange() {
            const s = Math.round(Number(diffStep.value));
            if (!Number.isFinite(s) || s < 1) {
                showStatus('⚠️ 逐差法步长需为不小于 1 的整数，已还原为 3', 'info');
                diffStep.value = 3;
            } else {
                diffStep.value = s;
            }
        }
        // 直径测量数据 (仅启用环参与)
        const diameterData = computed(() => {
            return calculateDiameterData(enabledRings.value, pixelScale.value);
        });
        // 曲率半径计算结果 (仅启用环参与，步长可人工调节)
        const radiusData = computed(() => {
            return calculateRadiusData(enabledRings.value, pixelScale.value, diffStep.value);
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

        // 键盘方向键微调标定标记 (仅标定页生效，避免与圆心微调冲突)
        function onCalibKeydown(e) {
            if (activeTab.value !== 'calibration') return;
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

        // OpenCV 图像处理主函数 (第一步：自动检测圆心，等待人工确认)
        async function processImage() {
            if (!imageManager.uploadedImage.value || !cvReady.value) {
                return showStatus('❌ 请先上传图像并等待 OpenCV 加载', 'error');
            }
            if (isProcessing.value) {
                return showStatus('⏳ 正在处理中，请稍候...', 'info');
            }

            isProcessing.value = true;
            try {
                // 重置流程状态与上次检测结果
                cleanupCenterAdjust?.();
                cleanupCenterAdjust = null;
                centerPhase.value = 'idle';
                detectedCenter.value = null;
                centerProcessedDataUrl.value = null;
                detectedOuterRadius.value = 0;
                resultImageSrcRef.value = null;
                clearCanvas(resultCanvasRef.value);
                const fingerprint = imageManager.currentFingerprint.value;
                if (fingerprint) {
                    sessionStorage.removeItem('calc_' + fingerprint);
                }
                // 第一步：预处理 + 自动检测圆心 (不识别环，先供人工确认)
                const centerResult = await detectNewtonRingCenter(
                    imageManager,
                    showStatus,
                    filterParams,
                    resultImageRef
                );
                if (!centerResult) {
                    showStatus('❌ 无法检测到牛顿环中心，请检查图像质量', 'error');
                    resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                    return;
                }
                detectedCenter.value = { x: Math.round(centerResult.x), y: Math.round(centerResult.y) };
                detectedOuterRadius.value = centerResult.outerRadius;
                centerProcessedDataUrl.value = centerResult.processedDataUrl;
                enterAwaitingCenterPhase();
                showStatus('🔍 请核对圆心：可拖拽/方向键微调/输入坐标，确认后再识别环', 'info');
            } catch (error) {
                console.error('处理错误:', error);
                showStatus(`❌ 处理失败: ${error.message}`, 'error');
                resultImageSrcRef.value = imageManager.getOriginalImageSrc();
            } finally {
                isProcessing.value = false;
            }
        }

        // 进入圆心待确认阶段：画圆心覆盖层 + 启用拖拽微调
        function enterAwaitingCenterPhase() {
            centerPhase.value = 'awaiting-center';
            nextTick(() => {
                cleanupCenterAdjust?.();
                cleanupCenterAdjust = initCenterAdjustInteraction(resultImageRef, resultCanvasRef, (newCenter) => {
                    detectedCenter.value = newCenter;
                });
            });
        }

        // 圆心变化 (拖拽/键盘/输入框) 或十字臂长变化 (+/- 键) 时重绘覆盖层 (由 watch 统一处理)
        watch([detectedCenter, centerCrossArm], () => {
            if (centerPhase.value !== 'awaiting-center' || !detectedCenter.value) return;
            const img = imageManager.uploadedImage.value;
            drawCenterOverlay(resultCanvasRef, detectedCenter.value, img?.width || 0, img?.height || 0, centerCrossArm.value);
        }, { deep: true });

        // 第二步：确认圆心并识别暗环 (人工兜底完成后的入口)
        async function confirmCenterAndDetectRings() {
            if (!detectedCenter.value || isProcessing.value) return;
            isProcessing.value = true;
            try {
                cleanupCenterAdjust?.();
                cleanupCenterAdjust = null;
                const darkRings = await detectRingsWithCenter(
                    imageManager,
                    showStatus,
                    detectedCenter.value.x,
                    detectedCenter.value.y,
                    centerProcessedDataUrl.value,
                    detectedOuterRadius.value,
                    resultImageRef
                );
                if (darkRings.length === 0) {
                    showStatus('⚠️ 未检测到暗环，请微调圆心或调整预处理参数后重试', 'error');
                    enterAwaitingCenterPhase();
                    return;
                }
                centerPhase.value = 'done';
                showStatus(`✅ 识别到 ${darkRings.length} 个暗环，可在下方表格去除错环/改编号，或点击图像补环`, 'success');
                // 处理完成后，绘制结果和初始化交互 (底图恢复为原图，标记层覆盖绘制)
                nextTick(() => {
                    drawDetectionResults(resultCanvasRef, imageManager);
                    initCanvasInteractionWrapper();
                    resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                });
            } catch (error) {
                console.error('环识别失败:', error);
                showStatus(`❌ 环识别失败: ${error.message}`, 'error');
                enterAwaitingCenterPhase();
            } finally {
                isProcessing.value = false;
            }
        }

        // 重新检测圆心 (放弃当前微调结果)
        async function redetectCenter() {
            if (isProcessing.value) return;
            cleanupCenterAdjust?.();
            cleanupCenterAdjust = null;
            await processImage();
        }

        // 键盘方向键微调圆心 (圆心确认阶段；Shift+方向键 = 5px；+/- 键调节十字光标臂长)
        function onCenterKeydown(e) {
            if (centerPhase.value !== 'awaiting-center' || activeTab.value !== 'rings') return;
            if (!detectedCenter.value) return;
            // 输入框聚焦时不拦截按键，避免影响坐标输入等操作
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            // +/- 键加长/减短圆心十字光标臂长 (每次 8px，范围 8~200)
            if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
                e.preventDefault();
                const delta = (e.key === '+' || e.key === '=') ? 8 : -8;
                centerCrossArm.value = Math.max(8, Math.min(200, centerCrossArm.value + delta));
                return;
            }
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
            const img = imageManager.uploadedImage.value;
            const maxX = (img?.width || 1) - 1;
            const maxY = (img?.height || 1) - 1;
            detectedCenter.value = {
                x: Math.max(0, Math.min(maxX, detectedCenter.value.x + dx)),
                y: Math.max(0, Math.min(maxY, detectedCenter.value.y + dy))
            };
        }

        // ===== 环人工核对操作 =====
        // 将当前环列表 (含勾选状态/编号修改) 写回缓存并重绘 (仅启用环参与绘制与计算)
        function persistRings() {
            const rings = ringList.value;
            if (rings.length === 0) return;
            const center = detectedCenter.value || currentImageData.value?.center || null;
            imageManager.saveCurrentResultToCache(rings, center);
            nextTick(() => drawDetectionResults(resultCanvasRef, imageManager));
        }

        // 勾选/取消勾选某环 (取消即从计算/绘图/导出中剔除，重新勾选可恢复)
        function onToggleRingEnabled() {
            // 顺延重排模式：启用环按半径顺序重新编号 1..N (会覆盖手动改过的编号)
            if (renumberOnRemove.value) {
                renumberEnabledRings();
            }
            persistRings();
        }

        // 顺延重排：启用环按半径从小到大编号 1..N；未启用环保留原编号 (仅显示，不参与计算)
        function renumberEnabledRings() {
            const enabled = ringList.value.filter(r => r.enabled).sort((a, b) => a.avgRadius - b.avgRadius);
            enabled.forEach((r, i) => { r.number = i + 1; });
        }

        // 编号策略开关变更 (二选一：保持原编号 / 顺延重排)；切到顺延模式立即对当前编号生效 (切换即生效)
        function onRenumberModeChange() {
            if (renumberOnRemove.value) {
                renumberEnabledRings();
                persistRings();
                showStatus('✅ 已切换为顺延重排：启用环已按半径重新编号 1..N (手动编号已被覆盖)', 'success');
            } else {
                showStatus('✅ 已切换为保持原编号：取消勾选不再改变其余环编号', 'info');
            }
        }

        // 修改环序号编号 (需为不小于 1 的整数；去除环后保持原编号不重排)
        function onRingNumberChange(ring) {
            const n = Math.round(Number(ring.number));
            if (!Number.isFinite(n) || n < 1) {
                showStatus('⚠️ 编号需为不小于 1 的整数，已还原', 'info');
                imageManager.dataVersion.value++;
                return;
            }
            ring.number = n;
            const dup = ringList.value.filter(r => r.enabled && r.number === n).length;
            if (dup > 1) showStatus(`⚠️ 编号 ${n} 重复，曲率分组计算可能异常，请检查`, 'info');
            persistRings();
        }

        // 加载预处理灰度图 (供点击补环提取实测环数据)
        async function loadPreprocessedGrayMat() {
            const url = centerProcessedDataUrl.value;
            if (!url) return null;
            try {
                const img = await new Promise((resolve, reject) => {
                    const el = new Image();
                    el.onload = () => resolve(el);
                    el.onerror = reject;
                    el.src = url;
                });
                let mat = cv.imread(img);
                if (mat.channels() > 1) {
                    const tmp = new cv.Mat();
                    cv.cvtColor(mat, tmp, cv.COLOR_BGR2GRAY);
                    mat.delete();
                    mat = tmp;
                }
                return mat;
            } catch (err) {
                console.warn('预处理图加载失败:', err);
                return null;
            }
        }

        // 点击图像手动补环 (识别结束后的人工兜底：漏检的暗纹点一下即可补入)
        async function completeRingAtClick(event) {
            if (centerPhase.value !== 'done') return;
            const imgEl = resultImageRef.value;
            const canvas = resultCanvasRef.value;
            if (!imgEl || !canvas) return;
            const center = detectedCenter.value || currentImageData.value?.center;
            if (!center) return;
            // 显示坐标 → 原始图像像素坐标 (与悬停检测同口径)
            const rect = imgEl.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const px = (event.clientX - rect.left) * scaleX;
            const py = (event.clientY - rect.top) * scaleY;
            const radius = Math.sqrt(Math.pow(px - center.x, 2) + Math.pow(py - center.y, 2));
            if (radius < 5) {
                showStatus('⚠️ 点击位置距圆心太近，无法补环', 'info');
                return;
            }
            // 用预处理图提取该半径处的实测数据 (关键点/椭圆拟合)
            const grayMat = await loadPreprocessedGrayMat();
            if (!grayMat) {
                showStatus('⚠️ 预处理图已失效，请点击“重新处理”后再补环', 'info');
                return;
            }
            const ring = extractRingDataForManual(grayMat, center.x, center.y, radius);
            grayMat.delete();
            if (!ring) {
                showStatus('❌ 补环失败：无法提取环数据', 'error');
                return;
            }
            ring.manual = true;
            // 与现有环合并后按半径重新排序编号 (编号可再人工修改)
            const merged = mergeAndNumberRings([...ringList.value, ring]);
            imageManager.saveCurrentResultToCache(merged, center);
            nextTick(() => drawDetectionResults(resultCanvasRef, imageManager));
            showStatus(`✅ 已手动补环 (半径 ${radius.toFixed(1)}px)，编号已按半径重排，可手动修改`, 'success');
        }

        // Canvas交互包装函数 (含点击补环)
        function initCanvasInteractionWrapper() {
            initCanvasInteraction(resultImageRef, resultCanvasRef, imageManager, hoveredRingRef);
            const img = resultImageRef.value;
            if (img) {
                img.addEventListener('click', completeRingAtClick);
            }
        }

        // 从缓存恢复显示 (已识别过的图直接进入人工核对阶段)
        function restoreFromCache(resultData) {
            drawDetectionResults(resultCanvasRef, imageManager);
            if (resultData?.detectedRings?.length > 0) {
                centerPhase.value = 'done';
                detectedCenter.value = resultData.center ? { ...resultData.center } : null;
            }
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
            // 键盘方向键微调标定标记与圆心微调
            document.addEventListener('keydown', onCalibKeydown);
            document.addEventListener('keydown', onCenterKeydown);
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

            // 两步确认流程 + 环人工核对
            centerPhase,
            detectedCenter,
            centerCrossArm,
            confirmCenterAndDetectRings,
            redetectCenter,
            ringList,
            manualRingCount,
            onToggleRingEnabled,
            onRingNumberChange,
            renumberOnRemove,
            onRenumberModeChange,
            diffStep,
            onDiffStepChange,

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
