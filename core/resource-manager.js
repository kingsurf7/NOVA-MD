const os = require('os');
const log = require('../utils/logger')(module);

class ResourceManager {
    constructor() {
        this.warningThreshold = 0.8;
        this.criticalThreshold = 0.9;
        this.checkInterval = 30000;
        this.monitoringEnabled = true;
        
        this.metrics = {
            memory: [],
            cpu: [],
            sessions: []
        };
        
        this.startMonitoring();
        log.success('✅ Resource Manager démarré');
    }

    startMonitoring() {
        if (this.monitoringEnabled) {
            setInterval(() => {
                this.checkResources();
            }, this.checkInterval);
        }
    }

    async checkResources() {
        try {
            const memoryUsage = process.memoryUsage();
            const freeMemory = os.freemem();
            const totalMemory = os.totalmem();
            const memoryUsagePercent = (totalMemory - freeMemory) / totalMemory;

            const cpuUsage = process.cpuUsage();
            const loadAverage = os.loadavg();

            const stats = {
                memory: {
                    used: Math.round(memoryUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                    total: Math.round(totalMemory / 1024 / 1024),
                    percent: Math.round(memoryUsagePercent * 100)
                },
                cpu: {
                    user: Math.round(cpuUsage.user / 1000),
                    system: Math.round(cpuUsage.system / 1000),
                    load: loadAverage[0]
                },
                uptime: Math.round(process.uptime()),
                timestamp: new Date().toISOString()
            };

            this.storeMetrics(stats);

            if (memoryUsagePercent > this.criticalThreshold) {
                log.error(`🚨 CRITIQUE: Utilisation mémoire à ${stats.memory.percent}%`);
                await this.handleCriticalMemory();
            } else if (memoryUsagePercent > this.warningThreshold) {
                log.warn(`⚠️  AVERTISSEMENT: Utilisation mémoire à ${stats.memory.percent}%`);
            }

            if (loadAverage[0] > os.cpus().length * 0.8) {
                log.warn(`⚠️  Charge CPU élevée: ${loadAverage[0]}`);
            }

            return stats;

        } catch (error) {
            log.error('❌ Erreur monitoring ressources:', error);
        }
    }

    storeMetrics(stats) {
        const now = Date.now();
        
        if (this.metrics.memory.length >= 100) {
            this.metrics.memory.shift();
            this.metrics.cpu.shift();
        }
        
        this.metrics.memory.push({
            timestamp: now,
            value: stats.memory.percent
        });
        
        this.metrics.cpu.push({
            timestamp: now,
            value: stats.cpu.load
        });
    }

    async handleCriticalMemory() {
        try {
            log.error('🚨 Gestion mémoire critique déclenchée');
            
            if (global.gc) {
                global.gc();
                log.info('🧹 Garbage collection forcé');
            }

            const used = process.memoryUsage().heapUsed / 1024 / 1024;
            log.info(`📊 Mémoire utilisée: ${Math.round(used * 100) / 100} MB`);

            if (used > 500) {
                log.warn('💡 Suggestion: Redémarrer le processus pour libérer la mémoire');
            }

        } catch (error) {
            log.error('❌ Erreur gestion mémoire critique:', error);
        }
    }

    canAcceptNewUser() {
        const memoryUsage = process.memoryUsage();
        const freeMemory = os.freemem();
        const totalMemory = os.totalmem();
        const memoryUsagePercent = (totalMemory - freeMemory) / totalMemory;

        const loadAverage = os.loadavg();
        const cpuLoad = loadAverage[0] / os.cpus().length;

        return memoryUsagePercent < this.warningThreshold && cpuLoad < 0.8;
    }

    getResourceStatus() {
        const memoryUsage = process.memoryUsage();
        const freeMemory = os.freemem();
        const totalMemory = os.totalmem();
        const memoryUsagePercent = (totalMemory - freeMemory) / totalMemory;

        const loadAverage = os.loadavg();
        const cpuLoad = loadAverage[0] / os.cpus().length;

        const status = memoryUsagePercent > this.criticalThreshold ? 'critical' : 
                     memoryUsagePercent > this.warningThreshold ? 'warning' : 
                     cpuLoad > 0.8 ? 'warning' : 'healthy';

        return {
            status: status,
            memory: {
                used: Math.round(memoryUsage.rss / 1024 / 1024),
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                total: Math.round(totalMemory / 1024 / 1024),
                percent: Math.round(memoryUsagePercent * 100)
            },
            cpu: {
                load: loadAverage[0],
                loadPerCore: cpuLoad,
                cores: os.cpus().length
            },
            uptime: Math.round(process.uptime()),
            timestamp: new Date().toISOString()
        };
    }

    getMetricsHistory() {
        return {
            memory: this.metrics.memory,
            cpu: this.metrics.cpu,
            period: 'last_100_checks'
        };
    }

    getResourceRecommendations() {
        const status = this.getResourceStatus();
        const recommendations = [];

        if (status.memory.percent > 80) {
            recommendations.push({
                level: 'high',
                type: 'memory',
                message: 'Utilisation mémoire élevée. Envisagez de scaler verticalement.',
                action: 'Augmenter la mémoire allouée'
            });
        }

        if (status.cpu.loadPerCore > 0.8) {
            recommendations.push({
                level: 'high',
                type: 'cpu',
                message: 'Charge CPU élevée. Envisagez de scaler horizontalement.',
                action: 'Ajouter plus de instances'
            });
        }

        if (status.uptime > 86400) {
            recommendations.push({
                level: 'low',
                type: 'maintenance',
                message: 'Processus actif depuis longtemps. Redémarrage recommandé.',
                action: 'Redémarrer le processus'
            });
        }

        return recommendations;
    }

    estimateMaxCapacity() {
        const status = this.getResourceStatus();
        const memoryPerSession = 50;
        const cpuPerSession = 0.1;
        
        const availableMemory = status.memory.total * (1 - status.memory.percent / 100);
        const availableCpu = status.cpu.cores * (1 - status.cpu.loadPerCore);
        
        const maxByMemory = Math.floor(availableMemory / memoryPerSession);
        const maxByCpu = Math.floor(availableCpu / cpuPerSession);
        
        return {
            estimatedMaxSessions: Math.min(maxByMemory, maxByCpu),
            limitingFactor: maxByMemory < maxByCpu ? 'memory' : 'cpu',
            details: {
                byMemory: maxByMemory,
                byCpu: maxByCpu,
                availableMemory: Math.round(availableMemory),
                availableCpu: availableCpu.toFixed(2)
            }
        };
    }
}

module.exports = ResourceManager;
