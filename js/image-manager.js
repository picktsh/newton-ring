const { ref } = Vue;

// 创建图片管理器 (负责图片上传、缓存、切换)
export function createImageManager() {
    const uploadedImage = ref(null);
    const processedImages = ref([]);
    const currentFingerprint = ref(null);
    // 数据版本号，用于触发响应式更新
    const dataVersion = ref(0);

    function generateImageFingerprint(file) {
        return `${file.name}_${file.size}_${file.lastModified}`;
    }

    // 加载图片文件
    async function loadImageFile(file, onLoadCallback) {
        const fingerprint = generateImageFingerprint(file);
        currentFingerprint.value = fingerprint;
        try {
            let imageData = getSessionItem(IMAGES_KEY)?.[fingerprint] || null;
            // 新图片则读取并存储到 sessionStorage
            if (!imageData) {
                const imageDataUrl = await readFileAsDataURL(file);
                const img = await dataURLToImage(imageDataUrl);
                imageData = {
                    imageDataUrl,
                    fileName: file.name,
                    width: img.naturalWidth,
                    height: img.naturalHeight
                };
                const allImages = getSessionItem(IMAGES_KEY) || {};
                allImages[fingerprint] = imageData;
                setSessionItem(IMAGES_KEY, allImages);
            }
            // 设置为当前图片
            uploadedImage.value = {
                src: imageData.imageDataUrl,
                width: imageData.width,
                height: imageData.height
            };
            // 检查是否有计算结果缓存
            const resultData = getSessionItem(CALCULATION_PREFIX + fingerprint);
            if (!processedImages.value.find(p => p.fingerprint === fingerprint)) {
                processedImages.value.push({
                    fingerprint,
                    fileName: imageData.fileName,
                    imageDataUrl: imageData.imageDataUrl,
                    width: imageData.width,
                    height: imageData.height,
                    processed: !!resultData
                });
            }
            onLoadCallback?.(resultData, !!resultData);
        } catch (error) {
            console.error('加载图片失败:', error);
        }
    }

    function readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function dataURLToImage(dataURL) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataURL;
        });
    }

    // 从处理列表删除图片
    function removeFromProcessedList(fingerprint, onRemoveCallback) {
        const index = processedImages.value.findIndex(p => p.fingerprint === fingerprint);
        if (index > -1) {
            processedImages.value.splice(index, 1);
        }
        const allImages = getSessionItem(IMAGES_KEY) || {};
        delete allImages[fingerprint];
        setSessionItem(IMAGES_KEY, allImages);
        removeSessionItem(CALCULATION_PREFIX + fingerprint);
        // 如果删除的是当前显示的图片，切换到下一张
        if (currentFingerprint.value === fingerprint) {
            currentFingerprint.value = null;
            uploadedImage.value = null;

            if (processedImages.value.length > 0) {
                const nextIndex = Math.min(index, processedImages.value.length - 1);
                switchToImage(processedImages.value[nextIndex].fingerprint, onRemoveCallback);
            } else {
                onRemoveCallback?.(null);
            }
        }
    }

    // 切换到指定图片
    function switchToImage(fingerprint, onSwitchCallback) {
        const imageData = getSessionItem(IMAGES_KEY)?.[fingerprint] || null;
        if (!imageData) {
            console.warn('图片不存在:', fingerprint);
            return;
        }
        currentFingerprint.value = fingerprint;
        // 记录最后查看的图片
        sessionStorage.setItem('lastViewedFingerprint', fingerprint);
        uploadedImage.value = {
            src: imageData.imageDataUrl,
            width: imageData.width,
            height: imageData.height
        };
        const resultData = getSessionItem(CALCULATION_PREFIX + fingerprint);
        onSwitchCallback?.(resultData);
    }

    // 保存检测结果到 sessionStorage
    function saveCurrentResultToCache(detectedRings) {
        if (!currentFingerprint.value) return;

        const ringsData = detectedRings.map(ring => ({
            ...ring,
            contour: ring.contour ? {
                // Int32Array 无法直接序列化，需转为普通数组
                data32S: Array.from(ring.contour.data32S)
            } : null
        }));
        const resultData = {
            detectedRings: ringsData,
            timestamp: Date.now()
        };

        setSessionItem(CALCULATION_PREFIX + currentFingerprint.value, resultData);

        const item = processedImages.value.find(p => p.fingerprint === currentFingerprint.value);
        if (item) {
            item.processed = true;
        }

        dataVersion.value++;
    }

    // 获取当前图片的完整数据 (包括检测结果和图像尺寸)
    function getCurrentImageData() {
        if (!currentFingerprint.value) return null;
        // 读取 dataVersion 触发响应式更新
        const _version = dataVersion.value;
        const resultData = getSessionItem(CALCULATION_PREFIX + currentFingerprint.value);
        if (!resultData) return null;
        const img = uploadedImage.value;
        return {
            ...resultData,
            originalWidth: img?.width || 0,
            originalHeight: img?.height || 0
        };
    }

    function getOriginalImageSrc() {
        return uploadedImage.value?.src || '';
    }

    const IMAGES_KEY = 'newtonRing_images';
    const CALCULATION_PREFIX = 'calc_';

    // sessionStorage 存取封装
    function getSessionItem(key) {
        try {
            const data = sessionStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            console.warn('读取失败:', e);
            return null;
        }
    }

    function setSessionItem(key, value) {
        try {
            sessionStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('保存失败:', e);
        }
    }

    function removeSessionItem(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (e) {
            console.warn('删除失败:', e);
        }
    }

    // 从 sessionStorage 加载缓存数据
    function loadCacheFromSession(onLoadCallback) {
        try {
            const allImages = getSessionItem(IMAGES_KEY) || {};
            const imageKeys = Object.keys(allImages);
            processedImages.value = [];
            for (const fingerprint of imageKeys) {
                const imageData = allImages[fingerprint];
                if (!imageData) continue;
                const resultData = getSessionItem(CALCULATION_PREFIX + fingerprint);
                processedImages.value.push({
                    fingerprint,
                    fileName: imageData.fileName,
                    imageDataUrl: imageData.imageDataUrl,
                    width: imageData.width,
                    height: imageData.height,
                    processed: !!resultData
                });
            }
            const lastFingerprint = sessionStorage.getItem('lastViewedFingerprint');
            if (lastFingerprint && imageKeys.includes(lastFingerprint)) {
                switchToImage(lastFingerprint, onLoadCallback);
            } else if (processedImages.value.length > 0) {
                switchToImage(processedImages.value[0].fingerprint, onLoadCallback);
            }
        } catch (e) {
            console.warn('缓存加载失败:', e);
        }
    }

    return {
        uploadedImage,
        processedImages,
        currentFingerprint,
        dataVersion,

        loadImageFile,
        removeFromProcessedList,
        switchToImage,
        saveCurrentResultToCache,
        getCurrentImageData,
        getOriginalImageSrc,
        loadCacheFromSession
    };
}
