// @ts-ignore
/* global Vue, cv */

import { createImageManager } from './image-manager.js';
import { detectNewtonRingCenter, detectRingsWithCenter, mergeAndNumberRings, extractRingDataForManual } from './image-processor.js';
import { initCanvasInteraction, onTableRowHover, onTableRowLeave, initDragDrop, initCenterAdjustInteraction } from './interaction-handler.js';
import { calculateDiameterData, calculateRadiusData, calculateAverageRadius, generateCalculationResults, calculateRadiusUncertainty } from './data-calculator.js';
import { drawDetectionResults, clearCanvas, drawCenterOverlay } from './canvas-drawer.js';
import {
    refineTranslationNear, refineTranslationByRings, verifyOverlayOffset, loadImageEl
} from './image-registrator.js';
import { RING_COLOR } from './constants.js';

const { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } = Vue;

// Vue 应用主组件
export default {
    setup() {
        const imageManager = createImageManager();

        const cvReady = ref(false);
        const pixelScale = ref(0.005);
        const logs = ref([]);
        const isProcessing = ref(false);
        const hoveredRingRef = ref(null);
        // 当前活动标签页 (从 sessionStorage 恢复); 白名单守卫: 非法/已废弃值 (如曾停留的 Tab3) 回落第一个板块, 避免刷新后整页空白
        const activeTab = ref(['calibration', 'rings'].includes(sessionStorage.getItem('activeTab')) ? sessionStorage.getItem('activeTab') : 'calibration'); // 默认落在第一个板块 (像素标定与位移测算)
        // 监听 tab 切换，持久化到 sessionStorage; 离开标定页时停止闪烁对比 (v-show 隐藏后动画无意义且会持续占用定时器)
        watch(activeTab, (val) => {
            sessionStorage.setItem('activeTab', val);
            if (val !== 'calibration') stopOverlayBlink();
        });
        // ===== 像素标定状态 =====
        // ===== 像素标定 sessionStorage 缓存 =====
        const CALIB_KEY = 'calib_images';
        const CALIB_POINT_KEY = 'calib_points';

        function saveCalibToSession() {
            const data = {
                imageA: calibImageA.value ? { src: calibImageA.value.src, name: calibImageA.value.name, width: calibImageA.value.width, height: calibImageA.value.height } : null,
                imageB: calibImageB.value ? { src: calibImageB.value.src, name: calibImageB.value.name, width: calibImageB.value.width, height: calibImageB.value.height } : null,
                scaleA: calibScaleA.value,
                scaleB: calibScaleB.value,
                distanceManual: calibDistanceManual.value,
                cropped: calibIsCropped.value // 刷新后据此继续保持圆形显示，并禁止对已是截取图的画面二次截取
            };
            try {
                sessionStorage.setItem(CALIB_KEY, JSON.stringify(data));
            } catch (e) {
                // 原图 dataURL 过大超出 sessionStorage 配额 (如「重新裁剪」恢复全尺寸原图后): 降级为不含图片的缓存，
                // 至少保住刻度/距离/截取标志，并避免每次改动都反复抛 QuotaExceededError 刷屏
                try {
                    sessionStorage.setItem(CALIB_KEY, JSON.stringify({ ...data, imageA: null, imageB: null }));
                    console.warn('标定图片过大，已跳过图片缓存 (仅保留刻度/距离):', e?.name || e);
                } catch (e2) { console.warn('标定缓存保存失败:', e2); }
            }
            // 点组单独存: 即便上面图片超配额，特征点/刻度差仍要落盘 (不再被图片写入的异常连带跳过)
            try {
                sessionStorage.setItem(CALIB_POINT_KEY, JSON.stringify(calibPointPairs.value));
            } catch (e) { console.warn('标定点组缓存保存失败:', e); }
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
                    calibRestoredCropped.value = !!(data.imageA && data.cropped);
                }
                const rawPoints = sessionStorage.getItem(CALIB_POINT_KEY);
                if (rawPoints) {
                    const pts = JSON.parse(rawPoints);
                    // 兼容旧单点/多组格式；单组模式只保留最后一组 (旧多组缓存取最近一次取点)
                    calibPointPairs.value = (Array.isArray(pts)
                        ? pts
                        : (pts?.pointA && pts?.pointB ? [{ a: pts.pointA, b: pts.pointB }] : [])).slice(-1);
                }
            } catch (e) { console.warn('标定缓存加载失败:', e); }
        }

        const calibImageA = ref(null);  // { src, name, width, height }
        const calibImageB = ref(null);
        // 特征点对 (单组模式): { a: {x,y}, b: {x,y} }，来自叠加画面取点 (一点击同时得到两图坐标)，每次取点替换上一组，表格只保留一行
        const calibPointPairs = ref([]);
        const calibScaleA = ref(null);       // 图A对应鼓轮刻度 (mm)
        const calibScaleB = ref(null);       // 图B对应鼓轮刻度 (mm)
        const calibDistanceManual = ref(null); // 手动输入的实际距离 (mm)，优先于自动差值
        const calibFileInputA = ref(null);
        const calibFileInputB = ref(null);
        // ===== 圆形截取: 在图A上框选圆形区域，同坐标同步应用到图B，确认后替换两图 (不自动重合) =====
        const calibCroppedOriginals = ref(null); // { A, B } 截取前原图备份 (非空=当前已截取，可一键恢复)
        const calibRestoredCropped = ref(false); // 刷新后从缓存恢复的图本身已是截取图 (无原图备份不可恢复，但仍需按圆形显示且禁止二次截取)
        const cropBusy = ref(false);             // 截取确认进行中
        const cropMsg = ref('');                 // 截取结果提示

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

        // 监听标定数据变化，自动缓存 (点组用深监听，增删/微调均触发)
        watch([calibImageA, calibImageB, calibPointPairs, calibScaleA, calibScaleB, calibDistanceManual], () => {
            saveCalibToSession();
        }, { deep: true });

        // ===== 叠加对齐 (粗对齐 + 精细对齐) =====
        // 图B绘制偏移 (px): 正值=向右/向下移动，图B像素 b 显示在 b + (dx, dy) 处
        const overlayDx = ref(0);
        const overlayDy = ref(0);
        const overlayFineDone = ref(false);   // 精细对齐完成 (仅此后允许在叠加画面上点击取点)
        const overlayFineBusy = ref(false);
        const overlayFineMsg = ref('');       // 精细对齐状态/结果直接显示在叠加卡片内 (标定页无日志面板)
        const overlayScore = ref(null);        // 实时重合度残差 (重叠区 |A−B| 均值, 越小越准)；null=未计算/不可用
        const overlayScoreBusy = ref(false);   // 残差计算进行中 (不阻塞滑块拖动，异步完成后更新)
        const overlayCheckBusy = ref(false);   // 一键检查对齐进行中
        const overlayLocked = ref(false);      // 对齐锁定: 锁定后偏移不可变，点击叠加画面即可手动取点
        const overlayKeyFocus = ref(false);   // 方向键作用于叠加偏移 (否则作用于特征点微调)
        let overlayPointsFromOverlay = false; // 当前特征点是否来自叠加取点 (偏移变化时随之作废)
        const overlayStageRef = ref(null);
        const overlayBaseImgRef = ref(null);
        const overlayBImgRef = ref(null);
        const overlayCanvasRef = ref(null);
        const overlayScale = ref(0);          // 显示宽度 / 原始像素宽度 (随容器宽度变化)
        const overlayBlendMode = ref('overlay'); // 'overlay' 半透明彩色叠加 | 'gray' 灰度叠加 (去色看重影更清楚)
        let overlayFitCenters = null;         // 环拟合成功时的两图环系圆心 (供取点半径复核与中心标记绘制)
        let overlayCheckCenters = null;       // 检查对齐得到的两图环系圆心 (随心A原位/心B随偏移移动，拖动滑块可见两标记靠近)
        // ===== 辅助对齐圆环 (纯视觉参考, 不参与配准/取点计算) =====
        const GUIDE_RING_COLORS = ['#ff00ff', '#00ffff', '#ffee00', '#00ff88', '#ff7700', '#bb00ff']; // 霓虹色, 与灰度牛顿环强区分
        const guideRings = ref([]);            // [{ id, x, y, r }] 同心环组: 所有环 x,y 恒等 (=共同圆心, 以第一环为准), 绘制时乘显示比例
        const guideSelectedId = ref(null);     // 当前选中的辅助环 id (拖拽/删除/高亮对象)
        let guideRingSeq = 0;                  // 自增 id (颜色按 id 取模, 删除中间环其余环颜色不跳变)
        let guideDrag = null;                  // 拖拽会话 { mode:'move'|'resize', id, startX, startY, origX, origY, origR }
        let guideDragSuppressClick = false;    // 拖拽结束后抑制紧随的 click, 避免误触发取点
        // 两图均已上传且尺寸一致才允许叠加对齐 (同机位拍摄前提)
        const overlayReady = computed(() => {
            return !!(calibImageA.value && calibImageB.value &&
                calibImageA.value.width === calibImageB.value.width &&
                calibImageA.value.height === calibImageB.value.height);
        });
        const overlaySizeMismatch = computed(() => !!(calibImageA.value && calibImageB.value && !overlayReady.value));
        const overlayMaxX = computed(() => overlayReady.value ? Math.round(calibImageA.value.width / 2) : 0);
        const overlayMaxY = computed(() => overlayReady.value ? Math.round(calibImageA.value.height / 2) : 0);
        // ===== 闪烁对比 (blink): 底图A/顶图B 透明度在两个相位间硬切交替，错位的环纹会明显跳动，对齐后跳动消失 =====
        // 相位 0 = 常态 {A 100% / B 50%} (即停止闪烁后的样子)；相位 1 = {A 50% / B 100%}，两图轮流占主导。
        // 只改 opacity、不碰偏移，故闪烁期间滑块/方向键移动图B 照常可用。
        const overlayBlinkOn = ref(false);      // 闪烁对比开关 (按钮文案/配色随之切换)
        const overlayBlinkPhase = ref(0);       // 0: A 100% / B 50%  |  1: A 50% / B 100%
        let overlayBlinkTimer = null;           // setInterval 句柄 (停止/换图/切页/卸载时必须清理)
        const BLINK_INTERVAL = 600;             // ms/相位 (约 0.8Hz，从容又不至于太慢)
        function stopOverlayBlink() {
            if (overlayBlinkTimer) { clearInterval(overlayBlinkTimer); overlayBlinkTimer = null; }
            overlayBlinkOn.value = false;
            overlayBlinkPhase.value = 0;        // 复位到常态相位，两图透明度恢复 A 100% / B 50%
        }
        function toggleOverlayBlink() {
            if (overlayBlinkOn.value) {
                stopOverlayBlink();
                showStatus('⏸ 已停止闪烁对比，恢复常态叠加 (图A 100% / 图B 50%)', 'info');
                return;
            }
            if (!overlayReady.value) return;
            if (overlayLocked.value) return;    // 锁定后偏移不可变、无法移动顶图，闪烁辅助无意义 (按钮同时已灰掉，此处兜底)
            overlayBlinkOn.value = true;
            overlayBlinkPhase.value = 0;
            overlayBlinkTimer = setInterval(() => {
                overlayBlinkPhase.value = overlayBlinkPhase.value ? 0 : 1;
            }, BLINK_INTERVAL);
            showStatus('👁 闪烁对比已开启 (600ms/相位): 拖滑块/方向键移动图B，错位处会跳动、对齐后跳动消失；再按一次停止', 'info');
        }
        // 底图A样式: 常态满不透明，闪烁相位1 时降到 50% 让顶图B占主导; 灰度叠加模式的去色滤镜行为保持不变
        const overlayImgAStyle = computed(() => ({
            opacity: (overlayBlinkOn.value && overlayBlinkPhase.value === 1) ? 0.5 : 1,
            filter: overlayBlendMode.value === 'gray' ? 'grayscale(1)' : 'none',
            transition: 'none'   // 硬切: blink 对比的判读价值就在瞬间跳变，CSS 过渡会把跳动感抹平
        }));
        const overlayImgBStyle = computed(() => ({
            position: 'absolute',
            // 用百分比定位而非「缓存显示比例 × px」: 百分比按叠加容器解析，而容器与图A显示框严格重合，
            // 所以窗口缩放/滚动条出现/切换板块使容器变宽变窄时，偏移永远即时正确，不存在比例失鲜
            left: (overlayDx.value / (calibImageA.value?.width || 1) * 100) + '%',
            top: (overlayDy.value / (calibImageA.value?.height || 1) * 100) + '%',
            width: '100%',
            opacity: (overlayBlinkOn.value && overlayBlinkPhase.value === 1) ? 1 : 0.5,
            // 灰度叠加模式: CSS 滤镜纯显示层去色 (不改变像素数据)，排除色彩干扰看重影更清楚；图A底图同步去色 (见 overlayImgAStyle)
            filter: overlayBlendMode.value === 'gray' ? 'grayscale(1)' : 'none',
            transition: 'none',
            pointerEvents: 'none'
        }));
        // 当前标定图是否已截取: 本次会话截取 (有原图备份可恢复) 或 刷新后从缓存恢复的截取图 (无备份)
        const calibIsCropped = computed(() => !!(calibCroppedOriginals.value || calibRestoredCropped.value));
        // 叠加容器样式: 截取后按圆形显示 —— 方形截取像素的内切圆正是用户框选的那个圆，圆外露出深色底
        const overlayStageStyle = computed(() => ({
            cursor: overlayFineDone.value ? 'crosshair' : 'default',
            borderRadius: calibIsCropped.value ? '50%' : '4px'
        }));
        // 显示模式按钮组下方的一行提示 (按当前模式给出判读方法)
        const overlayModeHint = computed(() => ({
            overlay: '图B以 50% 透明度彩色叠加，重影消失即对齐',
            gray: '两图去色后叠加，排除色彩干扰，重影消失即对齐'
        }[overlayBlendMode.value] || ''));
        // 精细对齐状态条样式 (按消息前缀着色: ✅成功 ⚠️不可靠 ❌失败 其它进行中)
        const overlayFineMsgStyle = computed(() => {
            const msg = overlayFineMsg.value;
            const ok = msg.startsWith('✅'), warn = msg.startsWith('⚠️'), err = msg.startsWith('❌');
            return {
                marginTop: '10px', padding: '8px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold',
                background: ok ? '#eafaf1' : warn ? '#fff3cd' : err ? '#fdecea' : '#eef2ff',
                color: ok ? '#27ae60' : warn ? '#856404' : err ? '#c0392b' : '#667eea'
            };
        });
        // 亚像素偏移读数 (精细对齐保留抛物线/拟合的浮点结果，整数时不显示小数)
        const overlayDxText = computed(() => Number.isInteger(overlayDx.value) ? String(overlayDx.value) : overlayDx.value.toFixed(1));
        const overlayDyText = computed(() => Number.isInteger(overlayDy.value) ? String(overlayDy.value) : overlayDy.value.toFixed(1));
        // 叠加画面重绘标记 (取点后显示各组特征点在叠加画面上的位置)
        watch([calibPointPairs, overlayDx, overlayDy, overlayScale], () => {
            if (overlayReady.value) nextTick(drawOverlayCanvas);
        }, { deep: true });
        // 偏移/显示比例变化: 节流重算实时重合度残差 (拖动滑块实时可见)
        watch([overlayDx, overlayDy, overlayScale], () => {
            if (!overlayReady.value) return;
            requestOverlayScoreUpdate();
        });
        // 图片更换/删除时重置叠加对齐状态 (偏移/精细对齐结果/叠加取点标志/检查标记/残差均失效)，
        // 同时清空圆形截取状态与截取前原图备份 (新图需重新框选)；
        // cropKeepOriginals=true 时表示本次图片替换来自截取确认，需保留原图备份 (监听器异步触发，晚于备份写入)
        let cropKeepOriginals = false;
        // 「重新裁剪」恢复原图时挂起的上次截取圆: 由下方图片监听器在重置截取状态后就地落地为红圈，
        // 同步且确定 (不再依赖 nextTick 在多个 watcher 之后抢跑，杜绝恢复后无圆可选)
        let cropRestorePending = null;   // { center:{x,y}, radius } | null
        watch([calibImageA, calibImageB], () => {
            if (cropKeepOriginals) {
                cropKeepOriginals = false;
            } else {
                calibCroppedOriginals.value = null;
                lastCropCenter.value = null;   // 新图/删除/恢复原图: 上次截取范围作废 (reCrop 已用局部变量捕获，不受影响)
                lastCropRadius.value = 0;
            }
            cropCenter.value = null;
            cropRadius.value = 0;
            if (cropRestorePending) {
                // 重新裁剪: 恢复原图后立即沿用上次截取圆 (在监听器内同步落地，红圈必然出现，无需等 nextTick)
                cropCenter.value = cropRestorePending.center;
                cropRadius.value = cropRestorePending.radius;
                cropRestorePending = null;
            }
            cropBusy.value = false;
            stopOverlayBlink();           // 换图/确认截取/重新裁剪: 停止闪烁并清理定时器，避免遗留动画
            overlayDx.value = 0;
            overlayDy.value = 0;
            overlayFineDone.value = false;
            overlayFineMsg.value = '';
            overlayKeyFocus.value = false;
            overlayPointsFromOverlay = false;
            calibPointPairs.value = []; // 图片更换后旧特征点坐标失效
            overlayFitCenters = null;
            overlayCheckCenters = null;
            overlayLocked.value = false;   // 换图后锁定失效，需重新对齐再锁定
            guideRings.value = [];         // 辅助环坐标基于旧图原始像素，换图后失效
            guideSelectedId.value = null;
            invalidateOverlayScoreCache();
            nextTick(updateDisplayScales);
            requestOverlayScoreUpdate();
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
        // 原始图像面板折叠: 默认折叠为细标题栏 (识别结果独占整行); 无图时强制展开保上传入口, 上传成功后自动折叠
        const ringsShowOriginal = ref(false);
        const ringsOriginalExpanded = computed(() => ringsShowOriginal.value || !imageManager.uploadedImage.value);
        // ===== 两步确认流程状态 =====
        // 'idle' 未开始 | 'awaiting-center' 待确认圆心 | 'done' 已识别环 (进入人工核对)
        const centerPhase = ref('idle');
        const detectedCenter = ref(null);          // { x, y } 当前圆心 (可人工微调)
        const centerCrossArm = ref(24);            // 圆心十字光标臂长 (px)，可用 +/- 键调节，范围 4~图像半对角线
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
        // 平均曲率半径的不确定度 (A类统计 + B类仪器误差传播, p=0.683/k=1 扩展, R = R̄ ± U)
        const radiusUncertainty = computed(() => {
            return calculateRadiusUncertainty(radiusData.value, averageRadius.value, pixelScale.value);
        });
        // 完整的计算结果对象
        const calculationResults = computed(() => {
            return generateCalculationResults(
                diameterData.value,
                radiusData.value,
                averageRadius.value,
                pixelScale.value,
                radiusUncertainty.value
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

        // ===== 像素标定计算 (多组特征点) =====
        // 表格行数据: 序号、两图坐标、ΔX/ΔY、像素距离、标定值 (有物理距离时)；多组模式下每组一行
        const calibPairRows = computed(() => calibPointPairs.value.map((p, i) => {
            const dx = Math.abs(p.a.x - p.b.x), dy = Math.abs(p.a.y - p.b.y);
            const dist = Math.hypot(dx, dy);
            return {
                id: i,
                ax: p.a.x, ay: p.a.y,
                bx: p.b.x, by: p.b.y,
                dx, dy, dist,
                value: calibPhysicalDistance.value > 0 && dist > 0 ? calibPhysicalDistance.value / dist : 0
            };
        }));
        // 像素距离 (多组模式取所有点组距离的平均值)
        const calibAvgDistance = computed(() => {
            const rows = calibPairRows.value;
            if (!rows.length) return 0;
            return rows.reduce((sum, r) => sum + r.dist, 0) / rows.length;
        });
        // 最终标定值 = 物理距离 ÷ 像素距离
        const calibValue = computed(() => {
            if (calibAvgDistance.value <= 0 || calibPhysicalDistance.value <= 0) return 0;
            return calibPhysicalDistance.value / calibAvgDistance.value;
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
                    } else {
                        calibImageB.value = data;
                    }
                    calibPointPairs.value = []; // 新图与旧特征点不对应，清空点组 (取点标记在叠加画面)
                    calibCroppedOriginals.value = null; // 新上传的图视为原图，清空截取备份与截取状态 (由图片监听器统一重置)
                    calibRestoredCropped.value = false;
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
        function handleCalibUploadA(e) { handleCalibUpload(e, 'A'); }
        function handleCalibUploadB(e) { handleCalibUpload(e, 'B'); }

        // 键盘 (仅标定页生效): 截取阶段 +/− 调大调小截取半径；叠加模式下 (最近操作过叠加区) 方向键微调图B叠加偏移
        function onCalibKeydown(e) {
            if (activeTab.value !== 'calibration') return;
            // 文本/数字输入框聚焦时不拦截任何按键 (避免干扰鼓轮刻度等输入)；range 滑块不排除，在其上按 +/− 应当生效
            const ae = document.activeElement;
            if (ae && ae.tagName === 'INPUT' && ae.type !== 'range') return;
            // 截取阶段: +/− (或 =/_) 调半径，Shift 加速 (±50px，否则 ±10px 与按钮同口径)；
            // 与环纹板块的 +/- (十字光标臂长) 不冲突，因为那里限定 activeTab==='rings'
            if (cropReady.value && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
                e.preventDefault();
                adjustCropRadius((e.key === '+' || e.key === '=') ? (e.shiftKey ? 50 : 10) : -(e.shiftKey ? 50 : 10));
                return;
            }
            const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
            if (isArrowKey && overlayReady.value && overlayKeyFocus.value) {
                e.preventDefault();
                const step = e.shiftKey ? 5 : 1;
                switch (e.key) {
                    case 'ArrowUp': shiftOverlayBy(0, -step); break;
                    case 'ArrowDown': shiftOverlayBy(0, step); break;
                    case 'ArrowLeft': shiftOverlayBy(-step, 0); break;
                    case 'ArrowRight': shiftOverlayBy(step, 0); break;
                }
                return;
            }
        }

        // ===== 叠加对齐操作 =====
        // 显示比例更新 (图A加载完成/窗口宽度变化时调用)
        function updateOverlayScale() {
            const img = overlayBaseImgRef.value;
            if (!img || !calibImageA.value || !img.clientWidth) return;
            overlayScale.value = img.clientWidth / calibImageA.value.width;
        }

        // 叠加图片加载完成: 更新显示比例 (图B首次解码完成时触发)
        function onOverlayImgLoad() {
            updateOverlayScale();
        }

        // 偏移变化: 精细对齐结果作废；叠加取出的特征点也随之作废 (位置已不再对应)；
        // 检查对齐的圆心标记保留 (心B随偏移移动，拖动滑块可直观看到两标记靠近/远离)
        function invalidateOverlayAlignment() {
            overlayFineDone.value = false;
            overlayFitCenters = null;
            if (overlayPointsFromOverlay) {
                overlayPointsFromOverlay = false;
                calibPointPairs.value = []; // 偏移已变，叠加取出的特征点坐标不再对应，全部作废重新取点
            }
        }

        // ===== 实时重合度残差: 重叠区 |A−B| 均值，越小说明叠得越准 =====
        // 全尺寸逐像素差值会让拖滑块卡顿，故两图先缩成小灰度图缓存 (长边≤0.48倍原图短边)，
        // 偏移变化时短防抖后异步重算；重叠区过小时残差无意义显示 —。
        let overlayScoreCache = null;      // { key, smallA, smallB, scale } 缩小灰度图缓存 (图片更换时释放重建)
        let overlayScoreTimer = null;      // 防抖定时器 (拖动滑块时避免逐帧重算)
        let overlayScoreComputing = false; // 计算进行中 (脏标志保证结束后补算最新偏移)
        let overlayScoreDirty = false;

        function invalidateOverlayScoreCache() {
            if (overlayScoreCache) {
                overlayScoreCache.smallA?.delete?.();
                overlayScoreCache.smallB?.delete?.();
                overlayScoreCache = null;
            }
            overlayScore.value = null;
        }

        function requestOverlayScoreUpdate() {
            if (!overlayReady.value || !cvReady.value) return;
            overlayScoreDirty = true;
            if (overlayScoreTimer || overlayScoreComputing) return; // 防抖中/计算中: 脏标志保证后续补算
            overlayScoreTimer = setTimeout(() => {
                overlayScoreTimer = null;
                runOverlayScoreCompute();
            }, 120);
        }

        // 加载单图并缩成小灰度图 (两图同尺寸同比例，保证逐像素可对齐相减)
        async function loadSmallGray(src, targetCols) {
            const imgEl = await loadImageEl(src);
            const mat = cv.imread(imgEl);
            const gray = new cv.Mat();
            try {
                cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
                const scale = targetCols / mat.cols;
                if (scale >= 1) return gray.clone();
                const small = new cv.Mat();
                cv.resize(gray, small, new cv.Size(), scale, scale, cv.INTER_AREA);
                return small;
            } finally {
                mat.delete();
                gray.delete();
            }
        }

        function runOverlayScoreCompute() {
            if (overlayScoreComputing) { overlayScoreDirty = true; return; }
            if (!overlayReady.value || !cvReady.value) return;
            overlayScoreComputing = true;
            overlayScoreBusy.value = true;
            (async () => {
                try {
                    const imgA = calibImageA.value, imgB = calibImageB.value;
                    if (!imgA || !imgB) return;
                    const key = imgA.src + '|' + imgB.src;
                    if (!overlayScoreCache || overlayScoreCache.key !== key) {
                        overlayScoreCache?.smallA?.delete?.();
                        overlayScoreCache?.smallB?.delete?.();
                        const targetCols = Math.max(200, Math.round(Math.min(imgA.width, imgA.height) * 0.48));
                        const [smallA, smallB] = await Promise.all([loadSmallGray(imgA.src, targetCols), loadSmallGray(imgB.src, targetCols)]);
                        overlayScoreCache = { key, smallA, smallB, scale: smallA.cols / imgA.width };
                    }
                    const { smallA, smallB, scale } = overlayScoreCache;
                    if (smallA.cols !== smallB.cols || smallA.rows !== smallB.rows) { overlayScore.value = null; return; }
                    const W = smallA.cols, H = smallA.rows;
                    // 绘制偏移换算到小图坐标: 图B像素 b 显示在 b+(sx,sy) 处，重叠区 = 显示坐标下两图都有内容的矩形
                    const sx = Math.round(overlayDx.value * scale), sy = Math.round(overlayDy.value * scale);
                    const x0 = Math.max(0, sx), x1 = Math.min(W, W + sx);
                    const y0 = Math.max(0, sy), y1 = Math.min(H, H + sy);
                    if (x1 - x0 < 40 || y1 - y0 < 40) { overlayScore.value = null; return; }
                    const dA = smallA.data, dB = smallB.data;
                    let sum = 0, cnt = 0;
                    for (let y = y0; y < y1; y += 2) {
                        const rowA = y * W, rowB = (y - sy) * W;
                        for (let x = x0; x < x1; x += 2) {
                            sum += Math.abs(dA[rowA + x] - dB[rowB + x - sx]);
                            cnt++;
                        }
                    }
                    overlayScore.value = cnt ? sum / cnt : null;
                } catch (err) {
                    console.warn('重合度残差计算失败:', err);
                    overlayScore.value = null;
                } finally {
                    overlayScoreComputing = false;
                    overlayScoreBusy.value = false;
                    if (overlayScoreDirty) { overlayScoreDirty = false; requestOverlayScoreUpdate(); }
                }
            })();
        }

        // 残差读数与分档 (仅相对比较有意义: 两图曝光差异会使基准不为 0，拖到最小即对齐)
        const overlayScoreText = computed(() => overlayScore.value == null ? '—' : overlayScore.value.toFixed(1));
        const overlayScoreLevel = computed(() => {
            const s = overlayScore.value;
            if (s == null) return 'na';
            if (s <= 12) return 'good';
            if (s <= 30) return 'mid';
            return 'bad';
        });
        const overlayScoreStyle = computed(() => {
            const map = {
                good: { background: '#eafaf1', color: '#27ae60', border: '1px solid #a9dfbf' },
                mid: { background: '#fff8e1', color: '#b7791f', border: '1px solid #f5d78e' },
                bad: { background: '#fdecea', color: '#c0392b', border: '1px solid #f5b7b1' },
                na: { background: '#f4f4f4', color: '#999', border: '1px solid #ddd' }
            };
            return { padding: '2px 10px', borderRadius: '10px', fontFamily: 'monospace', fontSize: '12px', fontWeight: 'bold', ...map[overlayScoreLevel.value] };
        });
        const overlayScoreHint = computed(() => ({
            good: '已接近对齐，可点「检查对齐」复核',
            mid: '还有偏差，继续往数值变小的方向微调',
            bad: '偏差较大，先叠合中心暗斑再调环纹',
            na: overlayScoreBusy.value ? '计算中…' : '重叠区过小或不可用'
        }[overlayScoreLevel.value]));

        // ===== 一键检查对齐: 两图独立拟合环系圆心，按当前偏移换算后求残差 (只读判定，不改变偏移) =====
        // 结论分级: ≤2px 准确 | ≤36px 建议直接点精细对齐 | 更大给出方向建议继续手动粗对齐；
        // 同时把两环系圆心画到叠加画面 (心B随偏移移动，拖动滑块可见两标记靠近/远离)
        async function runOverlayCheck() {
            if (!overlayReady.value || overlayCheckBusy.value || overlayFineBusy.value) return;
            if (!cvReady.value) {
                overlayFineMsg.value = '❌ OpenCV 尚未加载完成，请稍候再试';
                return showStatus('❌ OpenCV 尚未加载完成，请稍候再试', 'error');
            }
            stopOverlayBlink();   // 闪动干扰判读，且本次只读检查结果要看稳定画面
            overlayCheckBusy.value = true;
            overlayFineMsg.value = '🔍 正在检查对齐 (拟合两图环系圆心)…';
            try {
                const res = await verifyOverlayOffset(
                    { src: calibImageA.value.src }, { src: calibImageB.value.src },
                    overlayDx.value, overlayDy.value);
                if (!res.ok) {
                    overlayCheckCenters = null;
                    overlayFineMsg.value = `❌ 无法检查对齐: ${res.message}`;
                    showStatus(`❌ 检查对齐失败: ${res.message}`, 'error');
                    return;
                }
                overlayCheckCenters = { centerA: res.centerA, centerB: res.centerB };
                nextTick(drawOverlayCanvas);
                const devText = res.dev.toFixed(1);
                if (res.dev <= 2) {
                    overlayFineMsg.value = `✅ 对齐准确: 环系圆心残差 ${devText}px (${res.detail})，可直接取点；追求亚像素精度可再点「精细对齐」`;
                    showStatus(`✅ 检查对齐: 残差 ${devText}px，对齐准确`, 'success');
                } else {
                    const sugText = res.suggestion ? describeShiftDirection(res.suggestion.dx, res.suggestion.dy) : '';
                    const near = res.dev <= 36;
                    overlayFineMsg.value = `⚠️ 对齐不够: 环系圆心残差 ${devText}px (${res.detail})${sugText ? ` → 建议把圆环${sugText}` : ''}${near ? '；或直接点「精细对齐」自动微调' : '，偏差超出精细对齐范围，请先继续手动粗对齐'}`;
                    showStatus(`⚠️ 检查对齐: 残差 ${devText}px${sugText ? `，建议${sugText}` : ''}`, 'error');
                }
            } catch (err) {
                console.error('检查对齐错误:', err);
                overlayFineMsg.value = `❌ 检查对齐失败: ${err.message}`;
                showStatus(`❌ 检查对齐失败: ${err.message}`, 'error');
            } finally {
                overlayCheckBusy.value = false;
            }
        }

        // ===== 圆形截取 (手动框选 + 两图同坐标同步截取，截取后不自动重合，由用户在叠加对齐卡片手动粗对齐) =====
        // 圆形截取区状态: 圆心/半径均以图A原始像素坐标表示，图B使用完全相同的值 (两图同尺寸前提)
        const cropStageRef = ref(null);
        const cropBaseImgRef = ref(null);
        const cropCenter = ref(null);   // { x, y } 圆心 (原始像素)
        const cropRadius = ref(0);      // 半径 (原始像素)
        const lastCropCenter = ref(null); // 上次确认截取的圆心 (原图像素)，供「重新裁剪」沿用为起点
        const lastCropRadius = ref(0);    // 上次确认截取的半径 (原图像素)
        // 原图展示 (未经任何处理): 截取后优先取截取前备份，保证预览区始终保持上传时的原始图 (不随截取/处理变化)
        const calibOriginalA = computed(() => calibCroppedOriginals.value?.A || calibImageA.value);
        const calibOriginalB = computed(() => calibCroppedOriginals.value?.B || calibImageB.value);
        // 两图就绪且尺寸一致才进入框选态；已截取时卡片切到「已截取」态 (点「重新裁剪」恢复原图备份后回到框选态，不在截取图上重复截取)
        const cropReady = computed(() => overlayReady.value && !calibIsCropped.value);
        const cropRadiusMax = computed(() => overlayReady.value ? Math.floor(Math.min(calibImageA.value.width, calibImageA.value.height) / 2) : 0);
        const cropRadiusMin = 20;
        // 首次进入截取状态 (或更换图片后): 圆心居中、半径取短边 30%
        watch(cropReady, (ready) => {
            if (!ready || !calibImageA.value) return;
            if (!cropCenter.value) {
                cropCenter.value = { x: Math.round(calibImageA.value.width / 2), y: Math.round(calibImageA.value.height / 2) };
                cropRadius.value = Math.round(Math.min(calibImageA.value.width, calibImageA.value.height) * 0.3);
            }
        }, { immediate: true });
        // 刷新叠加区显示比例并重绘标记层 (窗口resize/图片更换时调用)。
        // 注: 截取红圈与图B偏移均已改用百分比几何 (按容器解析)，不再依赖任何缓存比例，故此处只需管叠加画布。
        function updateDisplayScales() {
            updateOverlayScale();
            if (overlayReady.value) nextTick(drawOverlayCanvas);
        }
        // 截取圆圈的覆盖层样式: 全部用「占原图宽/高的百分比」定位。容器是 inline-block 会紧包图片，
        // 与图片显示框严格重合，因此百分比直接等价于原图像素比例 —— 红圈永远等于实际截取区域，
        // 不需测量 clientWidth，也就不会因滚动条出现/窗口缩放/切换板块(v-show 时 clientWidth=0) 而失鲜。
        // 全局 box-sizing: border-box 下 2px 红边框内画，外缘即截取圆本身。
        const cropCircleStyle = computed(() => {
            if (!cropReady.value || !cropCenter.value || !calibImageA.value) return { display: 'none' };
            const W = calibImageA.value.width, H = calibImageA.value.height;
            if (!W || !H) return { display: 'none' };
            const r = cropRadius.value;
            return {
                position: 'absolute',
                left: ((cropCenter.value.x - r) / W * 100) + '%',
                top: ((cropCenter.value.y - r) / H * 100) + '%',
                width: (2 * r / W * 100) + '%',
                aspectRatio: '1',   // 高按宽等比 (百分比 height 会按容器高解析，图非正方形时圆会变椭)
                borderRadius: '50%',
                border: '2px solid #e74c3c',
                background: 'rgba(102, 126, 234, 0.08)',
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.35)', // 圈外区域压暗突出截取范围 (超出容器部分被裁剪隐藏)
                cursor: 'move'
            };
        });
        // 拖拽改半径手柄样式: 圆周 3 点钟(东侧)的实心红点+白描边 (与辅助环手柄同款视觉)，
        // 同样用「占原图百分比」几何定位 (与 cropCircleStyle 同口径，绝不用缓存显示比例)；
        // box-sizing:border-box 下 14px 含 2px 白边；zIndex 高于红圈，压在圈外压暗层之上；ew-resize 暗示左右拖改半径。
        const cropHandleStyle = computed(() => {
            if (!cropReady.value || !cropCenter.value || !calibImageA.value) return { display: 'none' };
            const W = calibImageA.value.width, H = calibImageA.value.height;
            if (!W || !H) return { display: 'none' };
            const r = cropRadius.value;
            return {
                position: 'absolute',
                left: ((cropCenter.value.x + r) / W * 100) + '%',
                top: (cropCenter.value.y / H * 100) + '%',
                width: '14px',
                height: '14px',
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                background: '#e74c3c',
                border: '2px solid #fff',
                boxShadow: '0 0 3px rgba(0, 0, 0, 0.5)',
                cursor: 'ew-resize',
                zIndex: 2
            };
        });
        // 截取参数读数 (原始像素): 圆心/半径/实际截取范围，供核对「所圈=所裁」
        const cropInfoText = computed(() => {
            if (!cropCenter.value || !calibImageA.value) return '';
            const r = cropRadius.value, W = calibImageA.value.width, H = calibImageA.value.height;
            const x0 = Math.max(0, cropCenter.value.x - r), y0 = Math.max(0, cropCenter.value.y - r);
            const size = Math.min(2 * r, W - x0, H - y0);
            return `圆心 (${cropCenter.value.x}, ${cropCenter.value.y}) · 半径 ${r} px · 截取 x ${x0}~${x0 + size}, y ${y0}~${y0 + size}`;
        });
        // 拖拽移动截取圆 (显示坐标 → 原始像素，限幅使圆完整落在图内)
        function onCropMouseDown(e) {
            if (!cropReady.value || !cropCenter.value || cropBusy.value) return;
            e.preventDefault();
            cropStageRef.value?.focus?.(); // preventDefault 会阻止默认聚焦，这里显式聚焦，拖完即可直接用键盘微调
            const imgEl = cropBaseImgRef.value;
            if (!imgEl) return;
            // 拖拽换算用「当下实测」的显示宽度 (而非缓存比例)，容器宽度无论怎么变都即时正确
            const shownW = imgEl.getBoundingClientRect().width || imgEl.clientWidth;
            if (!shownW) return;
            const scale = calibImageA.value.width / shownW;
            const startX = e.clientX, startY = e.clientY;
            const startC = { ...cropCenter.value };
            const move = (ev) => {
                const nx = Math.round(startC.x + (ev.clientX - startX) * scale);
                const ny = Math.round(startC.y + (ev.clientY - startY) * scale);
                const r = cropRadius.value, W = calibImageA.value.width, H = calibImageA.value.height;
                cropCenter.value = {
                    x: Math.max(r, Math.min(W - r, nx)),
                    y: Math.max(r, Math.min(H - r, ny))
                };
            };
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        }
        // 拖拽手柄改半径 (径向距离: 半径 = 圆心到鼠标的距离，与辅助环 resize 同口径):
        // 直接写 cropRadius，由 watch(cropRadius)→clampCropCenter 统一限幅 (20 ~ 短边一半) 并在圆放不下时推圆心，
        // 滑块/读数因绑同一 ref 实时跟随。坐标换算每次 move 重新实测显示框 (同 guideToOrig，滚动/缩放即时正确)。
        function onCropResizeStart(e) {
            if (!cropReady.value || !cropCenter.value || cropBusy.value) return;
            e.preventDefault();
            cropStageRef.value?.focus?.(); // 拖完即可继续用键盘 +/− 微调
            const imgEl = cropBaseImgRef.value;
            if (!imgEl) return;
            const toOrig = (ev) => {
                const rect = imgEl.getBoundingClientRect();
                if (!rect.width) return null;
                const scale = calibImageA.value.width / rect.width;
                return { ox: (ev.clientX - rect.left) * scale, oy: (ev.clientY - rect.top) * scale };
            };
            const move = (ev) => {
                const p = toOrig(ev), c = cropCenter.value;
                if (!p || !c) return;
                const dist = Math.round(Math.hypot(p.ox - c.x, p.oy - c.y));
                cropRadius.value = Math.max(cropRadiusMin, Math.min(cropRadiusMax.value, dist));
            };
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        }
        // +/− 调整截取半径 (默认 ±10px/次，限幅在 20px ~ 短边一半)；圆心跟随限幅统一交给 clampCropCenter
        function adjustCropRadius(delta) {
            if (!cropReady.value) return;
            cropRadius.value = Math.max(cropRadiusMin, Math.min(cropRadiusMax.value, cropRadius.value + delta));
        }
        function adjustCropRadiusPlus() { adjustCropRadius(10); }
        function adjustCropRadiusMinus() { adjustCropRadius(-10); }
        // 圆心/半径限幅: 保证整个圆完整落在图内。否则 confirmCrop 的截取框会被图像边界截断，
        // 剪出来的圆缺角，与红圈显示不一致。
        // 口径关键: 半径只做上下限限幅、完整保留用户给的值，圆心放不下时「推圆心」而不是「压半径」——
        // 若反过来把半径重设为当前圆心的最大可容纳值，滑块与 ±键会被立即弹回，半径彻底调不动
        function clampCropCenter() {
            if (!cropReady.value || !cropCenter.value || !calibImageA.value) return;
            if (!(cropRadius.value >= cropRadiusMin)) return; // 重置为 0 等非法值时不参与 (图片监听器会置 0)
            const W = calibImageA.value.width, H = calibImageA.value.height;
            if (cropRadiusMax.value < cropRadiusMin) return;  // 图太小放不下最小截取圆，交由 confirmCrop 报错
            const r = Math.max(cropRadiusMin, Math.min(cropRadiusMax.value, cropRadius.value));
            const { x: cx, y: cy } = cropCenter.value;
            const nx = Math.max(r, Math.min(W - r, cx));
            const ny = Math.max(r, Math.min(H - r, cy));
            if (r !== cropRadius.value) cropRadius.value = r;
            if (nx !== cx || ny !== cy) cropCenter.value = { x: nx, y: ny };
        }
        // 半径变化 (滑块直拖 / ±按钮 / 键盘 / 初始化) 后统一限幅: 以前只有 ±按钮走限幅，
        // 拖滑块把半径放大到圆心放不下时圆会超出图像，截取被截断 → 所圈≠所裁
        watch(cropRadius, () => clampCropCenter());
        // 截取区键盘操作 (容器聚焦后生效，点一下截取画面即获得焦点):
        // +/− 调半径 (Shift ±50px)、方向键移圆心 (Shift 加速)、Home 复位到居中+短边30%
        // 必需 stopPropagation: 否则事件会继续冒泡到 document 级的 onCalibKeydown，半径被调两次/圆心与叠加偏移同时变
        function onCropKeydown(e) {
            if (!cropReady.value || !cropCenter.value || cropBusy.value) return;
            const isRadiusKey = (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_');
            const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
            if (!isRadiusKey && !isArrowKey && e.key !== 'Home') return;
            e.preventDefault();
            e.stopPropagation();
            const W = calibImageA.value.width, H = calibImageA.value.height;
            if (isRadiusKey) {
                const step = e.shiftKey ? 50 : 10;
                adjustCropRadius((e.key === '+' || e.key === '=') ? step : -step);
                return;
            }
            if (e.key === 'Home') {
                cropCenter.value = { x: Math.round(W / 2), y: Math.round(H / 2) };
                cropRadius.value = Math.round(Math.min(W, H) * 0.3);
                return;
            }
            // 圆心步长按图像尺寸自适应 (约短边 1/300)，Shift ×5 粗调
            const step = Math.max(1, Math.round(Math.min(W, H) / 300)) * (e.shiftKey ? 5 : 1);
            let dx = 0, dy = 0;
            switch (e.key) {
                case 'ArrowUp': dy = -step; break;
                case 'ArrowDown': dy = step; break;
                case 'ArrowLeft': dx = -step; break;
                case 'ArrowRight': dx = step; break;
            }
            const r = cropRadius.value;
            cropCenter.value = {
                x: Math.max(r, Math.min(W - r, cropCenter.value.x + dx)),
                y: Math.max(r, Math.min(H - r, cropCenter.value.y + dy))
            };
        }
        // 确认截取: 两图用完全相同的圆心/半径剪下同一个外接正方形区域 → 替换为截取图并备份原图；
        // 不自动触发重合 (由用户在下方叠加对齐卡片自行拖滑块/方向键粗对齐，配合「闪烁对比」与重合度残差判读)
        // 后续叠加、取点、标定全部在截取图上完成，点卡片内「重新裁剪」可回退到原图重截 (取点标记随之清空)
        async function confirmCrop() {
            if (!cropReady.value || !cropCenter.value || cropBusy.value) return;
            if (!cropRadius.value || cropRadius.value < cropRadiusMin) return;
            cropBusy.value = true;
            cropMsg.value = '✂️ 正在截取…';
            try {
                const { x: cx, y: cy } = cropCenter.value, r = cropRadius.value;
                const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
                const size = Math.min(2 * r, calibImageA.value.width - x0, calibImageA.value.height - y0);
                if (size < cropRadiusMin * 2) {
                    cropMsg.value = '❌ 截取区域过小，请缩小半径或移动圆心到图内';
                    return;
                }
                const imgA = await loadImageEl(calibImageA.value.src);
                const imgB = await loadImageEl(calibImageB.value.src);
                // 方形裁切 (截取圆的外接正方形)，故意不做圆形 clip:
                // 圆外若留透明，配准入口 cv.imread → cvtColor(RGBA2GRAY) 会丢弃 alpha 把圆外变成纯黑，
                // 于是「黑底方块上一块亮圆盘」的圆周成为全图最强的人工锐边，而且两图圆心半径完全相同、
                // 这条边位置一模一样 —— Hough 假环 / 模板方差选块 / ORB 特征全会锁死在它上，
                // 配准结果恒为 Δ≈0 (圆边互相重合而环纹仍错开)，也使 equalizeHist 被 21.5% 纯黑角区带偏。
                // 保留方形真实像素即可彻底消除人工边界；圆形观感由叠加容器 border-radius:50% 提供 (内切圆=用户框选的圆)。
                const cut = (img) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = size; canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, x0, y0, size, size, 0, 0, size, size);
                    return canvas.toDataURL('image/png');
                };
                const origA = { ...calibImageA.value }, origB = { ...calibImageB.value };
                cropKeepOriginals = true; // 本次替换来自截取确认，图片监听器勿清空备份 (监听器异步触发，晚于此同步代码)
                calibCroppedOriginals.value = { A: origA, B: origB }; // 先备份再替换
                calibImageA.value = { src: cut(imgA), name: origA.name + ' (截取)', width: size, height: size };
                calibImageB.value = { src: cut(imgB), name: origB.name + ' (截取)', width: size, height: size };
                calibPointPairs.value = []; // 坐标基于原图，截取后作废 (在叠加画面重新取点)
                lastCropCenter.value = cropCenter.value ? { ...cropCenter.value } : null; // 记住本次截取范围，供「重新裁剪」沿用为起点
                lastCropRadius.value = cropRadius.value;
                cropCenter.value = null;
                cropRadius.value = 0;
                cropMsg.value = `✅ 截取完成 (${size}×${size}px，画面按圆形显示、像素为方形)，请在下方拖滑块粗对齐截取图 (开「闪烁对比」看错位)`;
                showStatus(`✅ 圆形截取完成 (${size}×${size}px)，未自动重合，请在下方拖滑块手动对齐`, 'success');
            } catch (err) {
                console.error('截取失败:', err);
                cropMsg.value = `❌ 截取失败: ${err.message}`;
                showStatus(`❌ 截取失败: ${err.message}`, 'error');
            } finally {
                cropBusy.value = false;
            }
        }
        // 恢复原图核心: 放弃截取结果，回到上传的原始图片 (叠加状态由图片监听器自动重置)；返回是否执行
        function doRestoreOriginals() {
            if (!calibCroppedOriginals.value) return false;
            const originals = calibCroppedOriginals.value;
            calibCroppedOriginals.value = null; // 先清备份，避免替换动作触发监听器前状态混乱 (监听器只重置截取框状态)
            calibRestoredCropped.value = false;
            calibImageA.value = originals.A;
            calibImageB.value = originals.B;
            return true;
        }
        // 重新裁剪: 恢复原图备份 → 截取卡片回到框选态 → 沿用上次截取圆为起点，全程无需重传图A/B (不在截取图上重复截取)。
        // 已锁定对齐或已取特征点时先确认 (会随图片替换被清空且不可撤销)；刷新后无原图备份则不可重裁。
        function reCrop() {
            if (!calibCroppedOriginals.value) return;
            if (overlayLocked.value || calibPointPairs.value.length > 0) {
                if (!window.confirm('重新裁剪会丢弃当前已锁定的对齐与已取的特征点，且不可撤销，确定继续？')) return;
            }
            const pendingCenter = lastCropCenter.value ? { ...lastCropCenter.value } : null;
            const pendingRadius = lastCropRadius.value || 0;
            // 挂起上次截取圆: 恢复原图会触发图片监听器重置截取状态，由监听器就地把这份挂起值落地为红圈 (同步、确定)。
            // 无有效值时留空，交 watch(cropReady) 铺默认圆 (居中 + 短边30%)。
            cropRestorePending = (pendingCenter && pendingRadius >= cropRadiusMin)
                ? { center: pendingCenter, radius: pendingRadius } : null;
            if (!doRestoreOriginals()) { cropRestorePending = null; return; }
            cropMsg.value = '🔄 已恢复原图，沿用上次截取范围，可重新框选后再次确认截取';
            showStatus('🔄 已恢复原图，可重新框选截取 (沿用上次截取范围)', 'info');
            nextTick(() => cropStageRef.value?.focus?.());
        }

        // 方向键/程序化移动叠加偏移 (限幅在滑块范围内)
        function shiftOverlayBy(dx, dy) {
            if (!overlayReady.value || overlayLocked.value) return; // 锁定后方向键不可移动偏移
            overlayDx.value = Math.max(-overlayMaxX.value, Math.min(overlayMaxX.value, overlayDx.value + dx));
            overlayDy.value = Math.max(-overlayMaxY.value, Math.min(overlayMaxY.value, overlayDy.value + dy));
            overlayFineMsg.value = '';
            invalidateOverlayAlignment();
        }

        // 滑块拖动回调: 键盘焦点切换到叠加模式，精细对齐结果作废 (偏移已变，旧状态信息不再有效)
        function onOverlayOffsetInput() {
            if (overlayLocked.value) return; // 锁定后滑块不可拖动 (控件已 disabled，此处兜底)
            overlayKeyFocus.value = true;
            overlayFineMsg.value = '';
            invalidateOverlayAlignment();
        }

        // 一键复位: 偏移归零重新粗对齐
        function resetOverlayShift() {
            if (overlayLocked.value) return; // 锁定后禁止复位偏移
            stopOverlayBlink();              // 复位后画面大幅跳动，先停闪烁再归零
            overlayDx.value = 0;
            overlayDy.value = 0;
            overlayKeyFocus.value = true;
            overlayFineMsg.value = '';
            invalidateOverlayAlignment();
            showStatus('✅ 叠加偏移已复位为零', 'info');
        }

        // 偏移修正量 → 人话方向描述 (绘制偏移增量 +Δx=图B右移, +Δy=图B下移；分量过小忽略)
        function describeShiftDirection(dx, dy) {
            const parts = [];
            const ax = Math.abs(dx), ay = Math.abs(dy);
            if (ax >= 0.5) parts.push(`${dx > 0 ? '右' : '左'}移约 ${Math.round(ax)}px`);
            if (ay >= 0.5) parts.push(`${dy > 0 ? '下' : '上'}移约 ${Math.round(ay)}px`);
            return parts.join('、');
        }

        // 精细对齐: 首选多环圆心拟合 (整圈采样免疫环纹局部自相似歧义)，失败回退局部模板微调；
        // 结果不可靠时保持位置不变并在卡片内提示 (附方向性调整建议)；成功时保留亚像素浮点偏移 (不取整，贯通到取点换算)
        async function runOverlayFineAlign() {
            if (!overlayReady.value || overlayFineBusy.value || overlayLocked.value) return; // 锁定后禁止精细对齐改动偏移
            if (!cvReady.value) {
                overlayFineMsg.value = '❌ OpenCV 尚未加载完成，请稍候再试';
                return showStatus('❌ OpenCV 尚未加载完成，请稍候再试', 'error');
            }
            stopOverlayBlink();   // 精细对齐会改偏移，闪动中难以观察微调结果
            overlayFineBusy.value = true;
            overlayFineMsg.value = '🔬 正在精细对齐 (拟合环系圆心)…';
            showStatus('🔬 正在精细对齐…', 'info');
            try {
                const args = [{ src: calibImageA.value.src }, { src: calibImageB.value.src }, overlayDx.value, overlayDy.value];
                const oldDx = overlayDx.value, oldDy = overlayDy.value;
                const ring = await refineTranslationByRings(...args);
                let res = ring;
                if (!ring.ok) {
                    overlayFineMsg.value = '🔬 环拟合不可用，改用局部模板微调…';
                    res = await refineTranslationNear(...args);
                }
                const method = res.method || '局部模板微调';
                if (res.ok) {
                    overlayDx.value = res.dx;   // 浮点亚像素偏移 (滑块仍可按 1px 手动覆盖)
                    overlayDy.value = res.dy;
                    overlayFitCenters = (res.centerA && res.centerB) ? { centerA: res.centerA, centerB: res.centerB } : null;
                    overlayFineDone.value = true;
                    overlayKeyFocus.value = true;
                    const moved = describeShiftDirection(res.dx - oldDx, res.dy - oldDy);
                    const movedText = moved ? `，本次${moved}` : '';
                    overlayFineMsg.value = `✅ 精细对齐完成 (${method}): 偏移 Δx=${overlayDxText.value}px, Δy=${overlayDyText.value}px${movedText} (${res.detail})，可点击叠加画面取点`;
                    showStatus(`✅ 精细对齐完成 (${method}): Δx=${overlayDxText.value}, Δy=${overlayDyText.value}${movedText} (${res.detail})`, 'success');
                } else {
                    const reasons = ring.ok ? res.message : `环拟合: ${ring.message}；模板微调: ${res.message}`;
                    // 方向性调整建议: 环拟合目标最可信 (拟合圆心反推)，其次模板修正方向；无方向信息时提示参考重合度残差粗对齐
                    const sug = (!ring.ok && ring.suggestion) ? ring.suggestion : res.suggestion;
                    const sugText = sug ? describeShiftDirection(sug.dx, sug.dy) : '';
                    overlayFineMsg.value = sugText
                        ? `⚠️ 结果不可靠，位置保持不变: ${reasons}。→ 建议: 把圆环${sugText} (滑块/方向键粗对齐) 后再点精细对齐`
                        : `⚠️ 结果不可靠，位置保持不变: ${reasons}。→ 建议: 参考重合度残差把数值调到最小后再点精细对齐`;
                    showStatus(`⚠️ 精细对齐结果不可靠，已保持当前位置不变${sugText ? `，建议${sugText}` : ''}: ${reasons}`, 'error');
                }
            } catch (err) {
                console.error('精细对齐错误:', err);
                overlayFineMsg.value = `❌ 精细对齐失败: ${err.message}`;
                showStatus(`❌ 精细对齐失败: ${err.message}`, 'error');
            } finally {
                overlayFineBusy.value = false;
            }
        }

        // ===== 对齐锁定: 用户目视确认对齐满意后点「确定对齐」锁住两图相对位置 =====
        // 锁定后偏移不可变 (滑块/方向键/精细对齐/复位全部禁用)，点击叠加画面即可手动取点；
        // 解锁恢复可调，但已取特征点坐标基于旧偏移立即失效，故解锁瞬间清空点组重新取点。
        function toggleOverlayLock() {
            if (!overlayReady.value) return;
            if (overlayLocked.value) {
                overlayLocked.value = false;
                calibPointPairs.value = [];   // 偏移将可变，旧点坐标失效，清空重新取点
                overlayPointsFromOverlay = false;
                showStatus('🔓 已解锁对齐，可继续调整偏移；已取特征点已清空', 'info');
            } else {
                stopOverlayBlink();           // 锁定后无法再移动顶图，闪烁辅助失效 (按钮同步灰掉)
                overlayLocked.value = true;
                showStatus('🔒 对齐已锁定，点击叠加画面任意位置即可手动取点', 'success');
            }
            nextTick(drawOverlayCanvas);
        }

        // 叠加画面点击取点 (仅对齐锁定后允许): 分别保存图A/图B各自的原始像素坐标。
        // 同一物理特征: 图B坐标 = 图A坐标 − 绘制偏移 (叠加时图B像素 b 显示在 b + (dx, dy) 处)
        function onOverlayClick(e) {
            if (guideDragSuppressClick) { guideDragSuppressClick = false; return; } // 刚拖拽过辅助环, 抑制本次 click 取点
            if (!overlayReady.value) return;
            overlayKeyFocus.value = true;
            if (!overlayLocked.value) {
                showStatus('⚠️ 请先点「确定对齐」锁定两图位置，再在叠加画面上取点', 'info');
                return;
            }
            const baseImg = overlayBaseImgRef.value;
            if (!baseImg || !calibImageA.value) return;
            const rect = baseImg.getBoundingClientRect();
            const scale = calibImageA.value.width / rect.width;
            const px = Math.round((e.clientX - rect.left) * scale * 1000) / 1000;
            const py = Math.round((e.clientY - rect.top) * scale * 1000) / 1000;
            if (px < 0 || py < 0 || px >= calibImageA.value.width || py >= calibImageA.value.height) return;
            // 亚像素偏移参与换算 (图B坐标 = 点击坐标 − 浮点绘制偏移)
            const bx = Math.round((px - overlayDx.value) * 1000) / 1000;
            const by = Math.round((py - overlayDy.value) * 1000) / 1000;
            if (bx < 0 || by < 0 || bx >= calibImageB.value.width || by >= calibImageB.value.height) {
                showStatus('⚠️ 该点击位置对应的图B特征点越出图像边界，请在两图重叠区域内点击', 'info');
                return;
            }
            // 半径一致性复核 (环拟合圆心可用时): 同一环上点到环系圆心的距离两图应相等，差异过大提示可能未取在同序环上 (仅警告不阻止)
            if (overlayFitCenters) {
                const dA = Math.hypot(px - overlayFitCenters.centerA.x, py - overlayFitCenters.centerA.y);
                const dB = Math.hypot(bx - overlayFitCenters.centerB.x, by - overlayFitCenters.centerB.y);
                if (Math.abs(dA - dB) > 3) {
                    showStatus(`⚠️ 半径复核: 该点到环系圆心距离两图相差 ${Math.abs(dA - dB).toFixed(1)}px，可能未取在同一环上，建议重新取点`, 'info');
                }
            }
            // 多组累积: 每次点击新增一组特征点 (表格新增一行)，坐标保留 3 位小数；表格与标定值响应式自动重算
            calibPointPairs.value = [...calibPointPairs.value, { a: { x: px, y: py }, b: { x: bx, y: by } }];
            overlayPointsFromOverlay = true;
            showStatus(`✅ 叠加取点 第${calibPointPairs.value.length}组: 图A (${px}, ${py}) | 图B (${bx}, ${by})`, 'success');
            nextTick(drawOverlayCanvas);
        }

        // 叠加画面标记层绘制: A点按图A坐标、B点按 图B坐标+偏移 换算到叠加画面显示坐标 (对齐良好时两点重合)
        function drawOverlayCanvas() {
            const canvas = overlayCanvasRef.value;
            const baseImg = overlayBaseImgRef.value;
            if (!canvas || !baseImg || !calibImageA.value) return;
            canvas.width = baseImg.clientWidth;
            canvas.height = baseImg.clientHeight;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const s = baseImg.clientWidth / calibImageA.value.width; // 实测换算，不用缓存比例
            // 圆心标记绘制: 心A原位、心B按当前偏移换算 (对齐良好时两中心重合；拖动滑块可见标记移动)
            const cm = (x, y, color, label) => {
                ctx.strokeStyle = color; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
                ctx.font = '10px monospace'; ctx.fillText(label, x + 7, y + 13);
            };
            // 精细对齐的环拟合圆心 (供取点参考)
            if (overlayFitCenters) {
                cm(overlayFitCenters.centerA.x * s, overlayFitCenters.centerA.y * s, '#e67e22', '心A');
                cm((overlayFitCenters.centerB.x + overlayDx.value) * s, (overlayFitCenters.centerB.y + overlayDy.value) * s, '#16a085', '心B');
            }
            // 检查对齐的环系圆心 (红/蓝区分，手动偏移时心B随之移动，直观看到偏差收敛)
            if (overlayCheckCenters) {
                cm(overlayCheckCenters.centerA.x * s, overlayCheckCenters.centerA.y * s, '#c0392b', '检A');
                cm((overlayCheckCenters.centerB.x + overlayDx.value) * s, (overlayCheckCenters.centerB.y + overlayDy.value) * s, '#2980b9', '检B');
            }
            // 辅助对齐圆环 (纯视觉参考): 虚线圆环 + 3点钟半径手柄; 选中环实线加粗 + 中心十字
            guideRings.value.forEach((ring, i) => {
                const color = GUIDE_RING_COLORS[ring.id % GUIDE_RING_COLORS.length];
                const x = ring.x * s, y = ring.y * s, r = ring.r * s;
                const selected = ring.id === guideSelectedId.value;
                ctx.setLineDash(selected ? [] : [6, 4]);
                ctx.strokeStyle = color;
                ctx.lineWidth = selected ? 2.5 : 1.5;
                ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
                ctx.setLineDash([]);
                // 半径手柄 (3点钟方向小圆点, 拖它调半径)
                ctx.beginPath(); ctx.arc(x + r, y, 5, 0, Math.PI * 2);
                ctx.fillStyle = color; ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
                if (selected) { // 选中环中心十字
                    ctx.strokeStyle = color; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
                }
                ctx.font = 'bold 10px monospace';
                ctx.fillStyle = color;
                ctx.fillText(`环${i + 1}`, x + 6, y - r - 4);
            });
            // 多组特征点标记: 锁定后每组 A/B 点重合，按图A坐标画一个彩色小点+编号 (编号与下方表格序号对应，颜色按序循环便于区分)
            const pairs = calibPointPairs.value;
            if (!pairs.length) return;
            const POINT_COLORS = ['#e74c3c', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#c0392b'];
            pairs.forEach((p, i) => {
                const x = p.a.x * s, y = p.a.y * s;
                const color = POINT_COLORS[i % POINT_COLORS.length];
                ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();          // 实心颜色小点
                ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); // 外圈增强可见性
                ctx.font = 'bold 10px monospace';
                ctx.fillStyle = color;
                ctx.fillText(String(i + 1), x + 8, y - 6);
            });
        }

        // ===== 辅助对齐圆环交互: 添加/删除/清空 + 画布拖拽 (环线条=移动圆心, 3点钟手柄=调半径) =====
        function guideRingColor(ring) { return GUIDE_RING_COLORS[ring.id % GUIDE_RING_COLORS.length]; }
        const guideSelectedRing = computed(() => guideRings.value.find(r => r.id === guideSelectedId.value) || null);
        // 添加辅助环: 同心环组, 新环圆心 = 第一环圆心 (共同圆心); 半径逐层外扩 = 最大环 + 短边×10%, 首环默认短边 20%
        function addGuideRing() {
            if (!overlayReady.value) return;
            const W = calibImageA.value.width, H = calibImageA.value.height;
            const first = guideRings.value[0];
            const cx = first ? first.x : Math.round(W / 2);
            const cy = first ? first.y : Math.round(H / 2);
            const maxR = guideRings.value.reduce((m, r) => Math.max(m, r.r), 0);
            const cr = guideRings.value.length ? Math.round(maxR + Math.min(W, H) * 0.1) : Math.round(Math.min(W, H) * 0.2);
            const ring = { id: guideRingSeq++, x: cx, y: cy, r: cr };
            guideRings.value = [...guideRings.value, ring];
            guideSelectedId.value = ring.id;
            showStatus(`⭕ 已添加辅助环${guideRings.value.length} (同心): 拖环线条移整组 / 拖右侧小圆手柄调该环半径`, 'info');
            nextTick(drawOverlayCanvas);
        }
        function removeGuideRing(id) {
            guideRings.value = guideRings.value.filter(r => r.id !== id);
            if (guideSelectedId.value === id) guideSelectedId.value = guideRings.value.length ? guideRings.value[0].id : null;
            nextTick(drawOverlayCanvas);
        }
        function clearGuideRings() {
            if (!guideRings.value.length) return;
            guideRings.value = [];
            guideSelectedId.value = null;
            nextTick(drawOverlayCanvas);
            showStatus('🧹 已清空辅助环', 'info');
        }
        // 鼠标事件坐标 → 图A原始像素 + 显示比例 (与取点同口径)
        function guideToOrig(e) {
            const baseImg = overlayBaseImgRef.value;
            if (!baseImg || !calibImageA.value) return null;
            const rect = baseImg.getBoundingClientRect();
            if (!rect.width) return null;
            const scale = calibImageA.value.width / rect.width;
            return { ox: (e.clientX - rect.left) * scale, oy: (e.clientY - rect.top) * scale, scale };
        }
        // 命中检测: 优先半径手柄 (3点钟小圆, 调该环半径), 其次环线条 ±容差 (移动整组共同圆心); 环内空白不命中 (留给取点点击)
        function guideHitTest(ox, oy, scale) {
            const handleTol = 9 * scale;  // 显示 9px 容差 → 原始像素
            const edgeTol = 8 * scale;    // 显示 8px 容差 → 原始像素
            for (let i = guideRings.value.length - 1; i >= 0; i--) {
                const ring = guideRings.value[i];
                if (Math.hypot(ox - (ring.x + ring.r), oy - ring.y) <= handleTol) return { mode: 'resize', ring };
            }
            for (let i = guideRings.value.length - 1; i >= 0; i--) {
                const ring = guideRings.value[i];
                if (Math.abs(Math.hypot(ox - ring.x, oy - ring.y) - ring.r) <= edgeTol) return { mode: 'move', ring };
            }
            return null;
        }
        // 叠加画面 mousedown: 命中辅助环则进入拖拽 (线条=移整组共同圆心, 手柄=调该环半径; 并抑制随后 click 取点), 未命中不拦截
        function onGuideMouseDown(e) {
            if (!overlayReady.value || !guideRings.value.length) return;
            const p = guideToOrig(e);
            if (!p) return;
            const hit = guideHitTest(p.ox, p.oy, p.scale);
            if (!hit) return;   // 未命中辅助环: 交给 click 走取点/无操作
            e.preventDefault();
            guideSelectedId.value = hit.ring.id;
            guideDrag = { mode: hit.mode, id: hit.ring.id, startX: p.ox, startY: p.oy, origX: hit.ring.x, origY: hit.ring.y, origR: hit.ring.r };
            const move = (ev) => {
                if (!guideDrag) return;
                const q = guideToOrig(ev);
                if (!q) return;
                const ring = guideRings.value.find(r => r.id === guideDrag.id);
                if (!ring) return;
                const W = calibImageA.value.width, H = calibImageA.value.height;
                if (guideDrag.mode === 'move') {
                    // 同心环组: 移动共同圆心 = 整组一起平移 (所有环 x,y 同步)
                    const nx = Math.max(0, Math.min(W, guideDrag.origX + (q.ox - guideDrag.startX)));
                    const ny = Math.max(0, Math.min(H, guideDrag.origY + (q.oy - guideDrag.startY)));
                    guideRings.value.forEach(r => { r.x = nx; r.y = ny; });
                } else {
                    // 半径 = 圆心到当前鼠标距离, 限幅 [10, 长边]
                    ring.r = Math.max(10, Math.min(Math.max(W, H), Math.hypot(q.ox - ring.x, q.oy - ring.y)));
                }
                nextTick(drawOverlayCanvas);
            };
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
                guideDrag = null;
                guideDragSuppressClick = true;  // 抑制紧随的 click (在 onOverlayClick 开头消费清除)
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
            nextTick(drawOverlayCanvas);
        }

        // 删除单张标定图片 (点组与截取备份随之失效)
        function removeCalibImage(slot) {
            if (slot === 'A') {
                calibImageA.value = null;
            } else {
                calibImageB.value = null;
            }
            calibPointPairs.value = [];
            calibCroppedOriginals.value = null;
            calibRestoredCropped.value = false;
            saveCalibToSession();
        }

        // 重置标定 (含清空点组与截取备份)
        function resetCalibration() {
            calibImageA.value = null;
            calibImageB.value = null;
            calibPointPairs.value = [];
            calibScaleA.value = null;
            calibScaleB.value = null;
            calibDistanceManual.value = null;
            calibCroppedOriginals.value = null;
            calibRestoredCropped.value = false;
            sessionStorage.removeItem(CALIB_KEY);
            sessionStorage.removeItem(CALIB_POINT_KEY);
        }

        // 删除特征点 (单组模式下即清除唯一一行，表格行与叠加画面标记同步移除)
        function removeCalibPair(index) {
            if (index < 0 || index >= calibPointPairs.value.length) return;
            calibPointPairs.value.splice(index, 1);
            nextTick(drawOverlayCanvas);
        }

        // 清空特征点 (需先确认，防误触)
        function clearCalibPairs() {
            if (!calibPointPairs.value.length) return;
            if (!confirm('确定清空当前特征点吗？')) return;
            calibPointPairs.value = [];
            nextTick(drawOverlayCanvas);
            showStatus('🗑️ 已清空特征点', 'info');
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

        // dataURL -> File: 环纹识别板块的上传管线 (imageManager.loadImageFile) 需要 File 对象生成指纹并用 FileReader 读取，
        // 而标定的图A 存的是 dataURL，故先还原成 File。lastModified 固定为 0 使同一张图重复导入指纹一致，不产生重复缩略图。
        function dataURLToFile(dataUrl, fileName) {
            const commaIdx = dataUrl.indexOf(',');
            const meta = dataUrl.slice(0, commaIdx);                 // data:image/png;base64
            const b64 = dataUrl.slice(commaIdx + 1);
            const mime = (meta.match(/data:(.*?)(;|$)/) || [, 'image/png'])[1];
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new File([bytes], fileName, { type: mime, lastModified: 0 });
        }

        // 一键导入图A: 把 tab1(像素标定) 的图A 原图导入 tab2(环纹识别) 的上传处，免去重复上传同一张图; tab2 仍可自己上传覆盖。
        // 始终导入未经圆形截取的原图 (calibOriginalA)——截取图是被裁过的小方块，尺寸小不利环识别。
        async function importCalibAToRings() {
            const imgA = calibOriginalA.value;
            if (!imgA || !imgA.src) {
                return showStatus('⚠️ tab1「像素标定」尚未上传图A，请先在图A处上传后再导入', 'info');
            }
            try {
                const file = dataURLToFile(imgA.src, imgA.name || '图A.png');
                showStatus(`⬇ 正在导入图A: ${file.name}`, 'info');
                await new Promise(resolve => imageManager.loadImageFile(file, () => resolve()));
                showStatus(`✅ 已导入图A: ${file.name}，开始识别…`, 'success');
                setTimeout(() => processImage(), 300);   // 与手动上传同口径：自动进入圆心检测
            } catch (err) {
                console.error('导入图A失败:', err);
                showStatus(`❌ 导入图A失败: ${err.message}`, 'error');
            }
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
            // +/- 键加长/减短圆心十字光标臂长 (每次 8px，Shift 加速 ×5=40px；上限动态取图像半对角线以够到任意外环，下限 4px 对准很小的最内圈)
            if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
                e.preventDefault();
                const step = 8 * (e.shiftKey ? 5 : 1);
                const delta = (e.key === '+' || e.key === '=') ? step : -step;
                const armImg = imageManager.uploadedImage.value;
                const maxArm = armImg ? Math.round(Math.hypot(armImg.width, armImg.height) / 2) : 200;
                centerCrossArm.value = Math.max(4, Math.min(maxArm, centerCrossArm.value + delta));
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
            const { diameterData, radiusData, averageR, pixelScale, uncertainty, timestamp } = calculationResults.value;
            let csv = '\uFEFF';
            csv += '牛顿环实验测量结果\n';
            csv += `生成时间:,${timestamp}\n`;
            csv += `像素标定:,${pixelScale} mm/像素\n`;
            csv += `平均曲率半径:,${averageR.toFixed(3)} m\n`;
            if (uncertainty && uncertainty.valid) {
                csv += `测量结果 (p=0.683):,R = (${uncertainty.meanText} ± ${uncertainty.uText}) m\n`;
                csv += `仪器示值误差限 Δ:,${uncertainty.deltaInstrument} mm\n`;
                csv += `直径 B 类 u_B(D):,${uncertainty.uBDText} mm\n`;
                csv += `A类不确定度 u_A:,${uncertainty.uAText} m\n`;
                csv += `B类不确定度 u_B:,${uncertainty.uBText} m\n`;
                csv += `合成标准不确定度 u_C:,${uncertainty.uCText} m\n`;
                csv += `扩展不确定度 U (p=0.683, k=${uncertainty.kText}):,${uncertainty.uText} m\n`;
                csv += `相对不确定度 U/R:,${uncertainty.relativeText}\n`;
            }
            csv += '\n';
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
            // 窗口宽度变化时更新截取区/叠加区显示比例 (两图按各自容器宽度自适应缩放)
            window.addEventListener('resize', updateDisplayScales);
            // 恢复标定图片缓存后重绘叠加画面标记 (含缓存的多组特征点)
            loadCalibFromSession();
            nextTick(() => {
                if (overlayReady.value) drawOverlayCanvas();
            });
        });

        // 组件卸载: 清理闪烁定时器 (与其余事件监听同口径，不遗留后台动画)
        onUnmounted(() => {
            stopOverlayBlink();
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
            ringsShowOriginal, ringsOriginalExpanded,

            diameterData,
            radiusData,
            averageRadius,
            radiusUncertainty,
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

            // 像素标定 (单组特征点: 表格一行 + 像素距离 3 位小数)
            calibImageA, calibImageB,
            calibPointPairs, calibPairRows, calibAvgDistance, calibValue,
            calibScaleA, calibScaleB,
            calibDistanceManual,
            calibAutoDistance, calibPhysicalDistance,
            calibFileInputA, calibFileInputB,
            handleCalibUploadA, handleCalibUploadB,
            removeCalibPair, clearCalibPairs,
            removeCalibImage,
            resetCalibration, applyCalibration,

            // 圆形截取 (两图同坐标同步截取，截取后在叠加对齐卡片手动粗对齐)
            calibCroppedOriginals,
            calibIsCropped,
            calibOriginalA, calibOriginalB,
            cropStageRef, cropBaseImgRef, cropCircleStyle, cropHandleStyle, cropInfoText,
            cropReady, cropBusy, cropMsg,
            cropRadius, cropRadiusMin, cropRadiusMax,
            adjustCropRadiusPlus, adjustCropRadiusMinus,
            onCropMouseDown, onCropResizeStart, onCropKeydown,
            confirmCrop, reCrop,

            // 叠加对齐 (粗对齐 + 精细对齐)
            overlayDx, overlayDy,
            overlayDxText, overlayDyText,
            overlayBlendMode,
            overlayModeHint,
            overlayFineDone, overlayFineBusy, overlayCheckBusy, overlayLocked, overlayFineMsg, overlayFineMsgStyle,
            overlayScore, overlayScoreText, overlayScoreStyle, overlayScoreHint,
            overlayReady, overlaySizeMismatch,
            overlayMaxX, overlayMaxY,
            overlayImgBStyle,
            overlayImgAStyle,
            overlayBlinkOn,
            toggleOverlayBlink,
            overlayStageStyle,
            overlayStageRef, overlayBaseImgRef, overlayBImgRef, overlayCanvasRef,
            updateOverlayScale,
            updateDisplayScales,
            onOverlayImgLoad,
            onOverlayOffsetInput,
            resetOverlayShift,
            runOverlayFineAlign,
            runOverlayCheck,
            toggleOverlayLock,
            onOverlayClick,
            guideRings, guideSelectedId, guideSelectedRing, guideRingColor,
            addGuideRing, removeGuideRing, clearGuideRings, onGuideMouseDown,

            handleFileUpload,
            processImage,
            importCalibAToRings,
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
