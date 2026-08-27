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

// 计算曲率半径 (使用逐差法，步长 m-n 可人工调节，默认 3)
export function calculateRadiusData(detectedRings, pixelScale, step = 3) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    const results = [];
    let totalRadius = 0;
    let validGroups = 0;
    const sortedRings = [...detectedRings].sort((a, b) => b.avgRadius - a.avgRadius);
    // 人工可修改编号且去除环后保持原编号，分组范围以最大编号为准 (而非环数)
    const maxRingNumber = Math.max(...sortedRings.map(r => r.number));
    // 动态生成分组配置 (步长由人工指定)
    const dynamicGroups = generateDynamicGroups(maxRingNumber, step);
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

// 动态生成分组配置 (步长可调，默认 3)
function generateDynamicGroups(maxRingNumber, step = 3) {
    if (maxRingNumber < step + 1) {
        return [];
    }
    const groups = [];
    for (let m = maxRingNumber; m >= step + 1; m--) {
        const n = m - step;
        if (n >= 1) {
            groups.push({ m, n });
            // 最多生成5组
            // if (groups.length >= 5) break;
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
