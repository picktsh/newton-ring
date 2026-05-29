// @ts-ignore
/* global Vue, cv */

import { createImageManager } from './image-manager.js';
import { processNewtonRings } from './image-processor.js';
import { initCanvasInteraction, onTableRowHover, onTableRowLeave, initDragDrop } from './interaction-handler.js';
import { calculateDiameterData, calculateRadiusData, calculateAverageRadius, generateCalculationResults } from './data-calculator.js';
import { drawDetectionResults, clearCanvas } from './canvas-drawer.js';

const { ref, reactive, computed, onMounted, nextTick } = Vue;

// Vue 应用主组件
export default {
    setup() {
        const imageManager = createImageManager();

        const cvReady = ref(false);
        const pixelScale = ref(0.005);
        const logs = ref([]);
        const isProcessing = ref(false);
        const hoveredRingRef = ref(null);
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

        // 上传文件处理
        async function handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            await loadImageFile(file);
        }

        async function loadImageFile(file) {
            await imageManager.loadImageFile(file, (resultData, isCached) => {
                resultImageSrcRef.value = imageManager.getOriginalImageSrc();
                if (isCached && resultData) {
                    showStatus(`✅ 已加载缓存: ${file.name}`, 'success');
                    nextTick(() => {
                        restoreFromCache(resultData);
                    });
                } else {
                    showStatus(`✅ 图像已加载，自动处理中...`, 'info');
                    setTimeout(() => processImage(), 500);
                }
            });
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
            initDragDrop(loadImageFile);
        });

        return {
            cvReady,
            pixelScale,
            logs,
            isProcessing,
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
