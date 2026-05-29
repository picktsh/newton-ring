import { LAMBDA } from './constants.js';

// 计算各暗环直径数据
export function calculateDiameterData(detectedRings, pixelScale) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    return detectedRings.map(ring => ({
        number: ring.number,
        diameterPixel: ring.avgRadius * 2,
        diameterMM: ring.avgRadius * 2 * pixelScale
    }));
}

// 计算曲率半径 (使用逐差法)
export function calculateRadiusData(detectedRings, pixelScale) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    const results = [];
    let totalRadius = 0;
    let validGroups = 0;
    const sortedRings = [...detectedRings].sort((a, b) => b.avgRadius - a.avgRadius);
    const maxRingNumber = sortedRings.length;
    // 动态生成分组配置
    const dynamicGroups = generateDynamicGroups(maxRingNumber);
    dynamicGroups.forEach(group => {
        const ringM = detectedRings.find(r => r.number === group.m);
        const ringN = detectedRings.find(r => r.number === group.n);

        if (ringM && ringN) {
            const Dm = ringM.avgRadius * 2 * pixelScale;
            const Dn = ringN.avgRadius * 2 * pixelScale;
            // R = (Dm² - Dn²) / [4(m-n)λ]
            const diffSquared = Math.pow(Dm, 2) - Math.pow(Dn, 2);
            const R = (diffSquared * 1e-6) / (4 * (group.m - group.n) * LAMBDA);

            results.push({
                group: `D${group.m} 与 D${group.n}`,
                m: group.m,
                n: group.n,
                diffSquared,
                radius: R
            });
            totalRadius += R;
            validGroups++;
        }
    });

    return results;
}

// 动态生成分组配置 (保证 m-n 的差值足够大)
function generateDynamicGroups(maxRingNumber) {
    if (maxRingNumber < 5) {
        return [];
    }
    const groups = [];
    // 步长至少为3，确保足够的差值
    const step = Math.max(3, Math.floor(maxRingNumber / 5));
    for (let i = 0; i < 5; i++) {
        const m = maxRingNumber - i * 2;
        const n = Math.max(1, m - step);
        if (m > n && m <= maxRingNumber && n >= 1) {
            groups.push({ m, n });
        }
    }
    return groups;
}

// 计算平均曲率半径
export function calculateAverageRadius(radiusData) {
    if (!radiusData || radiusData.length === 0) {
        return 0;
    }
    const total = radiusData.reduce((sum, item) => sum + item.radius, 0);
    return total / radiusData.length;
}

// 生成完整的计算结果对象
export function generateCalculationResults(diameterData, radiusData, averageRadius, pixelScale) {
    if (!diameterData || diameterData.length === 0) {
        return null;
    }
    return {
        diameterData,
        radiusData,
        averageR: averageRadius,
        pixelScale,
        timestamp: new Date().toLocaleString('zh-CN')
    };
}
