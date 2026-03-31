/**
 * Memory monitoring utility for long-running bot sessions
 * Tracks heap usage and warns on potential memory leaks
 */

import { log } from '../notifications/Logger'

interface MemorySnapshot {
    timestamp: number
    heapUsedMB: number
    heapTotalMB: number
    externalMB: number
    rssMB: number
}

interface MemoryConfig {
    /** Threshold in MB to trigger warning (default: 500MB) */
    warningThresholdMB?: number
    /** Threshold in MB to trigger critical alert (default: 1024MB) */
    criticalThresholdMB?: number
    /** Minimum growth rate (MB/hour) to consider a leak (default: 50MB/hour) */
    leakRateMBPerHour?: number
    /** Sampling interval in milliseconds (default: 60000 = 1 minute) */
    samplingIntervalMs?: number
    /** Number of samples to keep for trend analysis (default: 60) */
    maxSamples?: number
}

const DEFAULT_CONFIG: Required<MemoryConfig> = {
    warningThresholdMB: 500,
    criticalThresholdMB: 1024,
    leakRateMBPerHour: 50,
    samplingIntervalMs: 60000,
    maxSamples: 60
}

export class MemoryMonitor {
    private config: Required<MemoryConfig>
    private samples: MemorySnapshot[] = []
    private intervalId: NodeJS.Timeout | null = null
    private startTime: number = Date.now()
    private warningEmitted: boolean = false
    private criticalEmitted: boolean = false

    constructor(config?: MemoryConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    /**
     * Start monitoring memory usage at configured interval
     */
    start(): void {
        if (this.intervalId) {
            return // Already running
        }

        this.startTime = Date.now()
        this.samples = []
        this.warningEmitted = false
        this.criticalEmitted = false

        // Take initial sample
        this.takeSample()

        // Schedule periodic sampling
        this.intervalId = setInterval(() => {
            this.takeSample()
            this.analyzeMemory()
        }, this.config.samplingIntervalMs)

        log('main', 'MEMORY', `Memory monitoring started (warning: ${this.config.warningThresholdMB}MB, critical: ${this.config.criticalThresholdMB}MB)`)
    }

    /**
     * Stop monitoring and clear resources
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }

        // Log final summary
        if (this.samples.length > 0) {
            const summary = this.getSummary()
            log('main', 'MEMORY', `Monitor stopped. Peak: ${summary.peakHeapMB.toFixed(1)}MB, Avg: ${summary.avgHeapMB.toFixed(1)}MB, Growth: ${summary.growthRateMBPerHour.toFixed(2)}MB/h`)
        }
    }

    /**
     * Take a memory usage sample
     */
    private takeSample(): void {
        const usage = process.memoryUsage()

        const snapshot: MemorySnapshot = {
            timestamp: Date.now(),
            heapUsedMB: usage.heapUsed / (1024 * 1024),
            heapTotalMB: usage.heapTotal / (1024 * 1024),
            externalMB: usage.external / (1024 * 1024),
            rssMB: usage.rss / (1024 * 1024)
        }

        this.samples.push(snapshot)

        // Keep only recent samples
        if (this.samples.length > this.config.maxSamples) {
            this.samples.shift()
        }
    }

    /**
     * Analyze memory trends and emit warnings if needed
     */
    private analyzeMemory(): void {
        if (this.samples.length < 2) {
            return
        }

        const latest = this.samples[this.samples.length - 1]
        if (!latest) {
            return
        }

        // Check absolute thresholds
        if (latest.heapUsedMB >= this.config.criticalThresholdMB && !this.criticalEmitted) {
            this.criticalEmitted = true
            log('main', 'MEMORY', `CRITICAL: Heap usage (${latest.heapUsedMB.toFixed(1)}MB) exceeds critical threshold (${this.config.criticalThresholdMB}MB)`, 'error')
            this.logDetailedUsage()
        } else if (latest.heapUsedMB >= this.config.warningThresholdMB && !this.warningEmitted) {
            this.warningEmitted = true
            log('main', 'MEMORY', `WARNING: Heap usage (${latest.heapUsedMB.toFixed(1)}MB) exceeds warning threshold (${this.config.warningThresholdMB}MB)`, 'warn')
        }

        // Reset warning flags if memory drops below thresholds (allows re-warning)
        if (latest.heapUsedMB < this.config.warningThresholdMB * 0.8) {
            this.warningEmitted = false
        }
        if (latest.heapUsedMB < this.config.criticalThresholdMB * 0.8) {
            this.criticalEmitted = false
        }

        // Check for memory leak pattern (sustained growth)
        const growthRate = this.calculateGrowthRate()
        if (growthRate > this.config.leakRateMBPerHour && this.samples.length >= 10) {
            log('main', 'MEMORY', `Potential memory leak detected: ${growthRate.toFixed(2)}MB/hour growth rate`, 'warn')
        }
    }

    /**
     * Calculate memory growth rate in MB/hour using linear regression
     */
    private calculateGrowthRate(): number {
        if (this.samples.length < 5) {
            return 0
        }

        // Simple linear regression on recent samples
        const recentSamples = this.samples.slice(-Math.min(30, this.samples.length))
        const n = recentSamples.length

        if (n === 0) {
            return 0
        }

        const firstSample = recentSamples[0]
        if (!firstSample) {
            return 0
        }

        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
        const firstTimestamp = firstSample.timestamp

        for (let i = 0; i < n; i++) {
            const sample = recentSamples[i]
            if (!sample) continue
            const x = (sample.timestamp - firstTimestamp) / 3600000 // Hours
            const y = sample.heapUsedMB
            sumX += x
            sumY += y
            sumXY += x * y
            sumX2 += x * x
        }

        const denominator = n * sumX2 - sumX * sumX
        if (denominator === 0) {
            return 0
        }

        // Slope = growth rate in MB/hour
        return (n * sumXY - sumX * sumY) / denominator
    }

    /**
     * Log detailed memory usage breakdown
     */
    private logDetailedUsage(): void {
        const usage = process.memoryUsage()
        log('main', 'MEMORY', `Detailed: Heap ${(usage.heapUsed / 1024 / 1024).toFixed(1)}/${(usage.heapTotal / 1024 / 1024).toFixed(1)}MB, RSS ${(usage.rss / 1024 / 1024).toFixed(1)}MB, External ${(usage.external / 1024 / 1024).toFixed(1)}MB`)
    }

    /**
     * Get current memory usage summary
     */
    getSummary(): { currentHeapMB: number; peakHeapMB: number; avgHeapMB: number; growthRateMBPerHour: number; uptimeHours: number } {
        const lastSample = this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined
        const current = lastSample?.heapUsedMB ?? 0
        const peak = this.samples.reduce((max, s) => Math.max(max, s.heapUsedMB), 0)
        const avg = this.samples.length > 0 ? this.samples.reduce((sum, s) => sum + s.heapUsedMB, 0) / this.samples.length : 0
        const growthRate = this.calculateGrowthRate()
        const uptimeHours = (Date.now() - this.startTime) / 3600000

        return {
            currentHeapMB: current,
            peakHeapMB: peak,
            avgHeapMB: avg,
            growthRateMBPerHour: growthRate,
            uptimeHours
        }
    }

    /**
     * Force garbage collection if available (requires --expose-gc flag)
     */
    forceGC(): boolean {
        if (typeof global.gc === 'function') {
            global.gc()
            log('main', 'MEMORY', 'Forced garbage collection executed')
            return true
        }
        return false
    }

    /**
     * Get instant memory snapshot without modifying samples
     */
    static getInstantUsage(): { heapUsedMB: number; heapTotalMB: number; rssMB: number } {
        const usage = process.memoryUsage()
        return {
            heapUsedMB: usage.heapUsed / (1024 * 1024),
            heapTotalMB: usage.heapTotal / (1024 * 1024),
            rssMB: usage.rss / (1024 * 1024)
        }
    }
}

// Singleton instance for global access
let globalMonitor: MemoryMonitor | null = null

/**
 * Get or create the global memory monitor instance
 */
export function getMemoryMonitor(config?: MemoryConfig): MemoryMonitor {
    if (!globalMonitor) {
        globalMonitor = new MemoryMonitor(config)
    }
    return globalMonitor
}

/**
 * Stop and release the global memory monitor
 */
export function stopMemoryMonitor(): void {
    if (globalMonitor) {
        globalMonitor.stop()
        globalMonitor = null
    }
}
