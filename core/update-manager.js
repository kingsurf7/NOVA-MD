const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger')(module);

class UpdateManager {
    constructor(bot, sessionManager) {
        this.bot = bot;
        this.sessionManager = sessionManager;
        this.isUpdating = false;
        this.lastCheck = null;
        this.currentVersion = config.bot.version;
        this.updateCheckInterval = null;
        
        if (config.features.autoUpdate) {
            this.startAutoUpdateCheck();
        }
    }

    startAutoUpdateCheck() {
        this.updateCheckInterval = setInterval(() => {
            this.checkForUpdates();
        }, config.updates.check_interval);

        log.update(this.currentVersion, 'Système de mise à jour automatique activé');
    }

    async checkForUpdates(forceCheck = false) {
        if (this.isUpdating) {
            log.update(this.currentVersion, 'Mise à jour déjà en cours, vérification ignorée');
            return;
        }

        try {
            const response = await axios.get(
                `https://api.github.com/repos/${config.updates.github_repo}/commits?sha=${config.updates.branch}&per_page=1`,
                { timeout: 10000 }
            );
            
            const latestCommit = response.data[0];
            const latestCommitHash = latestCommit.sha.substring(0, 8);
            const currentHash = await this.getCurrentCommitHash();

            const updateInfo = {
                available: forceCheck || latestCommitHash !== currentHash,
                current: this.currentVersion,
                currentHash: currentHash,
                latestHash: latestCommitHash,
                commit: latestCommit,
                lastCommitDate: latestCommit.commit.author.date,
                force: forceCheck
            };

            if (updateInfo.available) {
                log.update(this.currentVersion, `Nouvelles modifications disponibles: ${latestCommitHash}`);
                
                await this.notifyAdmins(
                    `🔄 *Modifications disponibles*\\n\\n` +
                    `Dernier commit: ${latestCommitHash}\\n` +
                    `Date: ${new Date(latestCommit.commit.author.date).toLocaleDateString('fr-FR')}\\n` +
                    `Message: ${latestCommit.commit.message}\\n\\n` +
                    `Utilisez le bouton 🔄 Mise à Jour pour synchroniser`
                );
            } else {
                log.update(this.currentVersion, 'Déjà à jour avec le dernier commit');
            }
            
            return updateInfo;

        } catch (error) {
            log.error('Erreur vérification mises à jour:', error.message);
            return { 
                available: false, 
                error: error.message,
                current: this.currentVersion,
                currentHash: await this.getCurrentCommitHash()
            };
        }
    }

    async getCurrentCommitHash() {
        return new Promise((resolve) => {
            exec('git rev-parse --short HEAD', { cwd: process.cwd() }, (error, stdout) => {
                if (error) {
                    log.error('Erreur récupération hash commit:', error);
                    resolve('unknown');
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    async performUpdate(force = false) {
        if (this.isUpdating) {
            throw new Error('Mise à jour déjà en cours');
        }

        this.isUpdating = true;
        
        try {
            log.update(this.currentVersion, '🚀 Début de la mise à jour sans déconnexion...');

            const sessionsBefore = this.getSessionsSnapshot();
            await this.backupCustomCommands();
            await this.executeGitUpdate();
            await this.updateDependencies();
            await this.reloadModulesDynamically();
            const sessionsAfter = this.getSessionsSnapshot();
            await this.verifySessionsIntegrity(sessionsBefore, sessionsAfter);
            await this.updateCommandsFromGitHub();

            const updateInfo = await this.checkForUpdates(true);
            
            log.update(this.currentVersion, '✅ Mise à jour terminée - Sessions intactes');
            
            await this.notifyAdmins(
                `✅ *Mise à jour réussie!*\\n\\n` +
                `Nouveau commit: ${updateInfo.latestHash}\\n` +
                `Sessions WhatsApp: ✅ Toutes préservées (${sessionsAfter.length})\\n` +
                `Commandes: ✅ Mises à jour\\n` +
                `Redémarrage: ❌ Non nécessaire\\n\\n` +
                `*Le bot fonctionne avec les nouvelles modifications*`
            );

            return { 
                success: true, 
                from: this.currentVersion, 
                to: updateInfo.latestHash,
                sessionsPreserved: sessionsAfter.length,
                sessionsBefore: sessionsBefore.length,
                sessionsAfter: sessionsAfter.length,
                restartRequired: false
            };

        } catch (error) {
            log.error('❌ Erreur lors de la mise à jour:', error);
            
            await this.notifyAdmins(
                `❌ *Échec de la mise à jour*\\n\\n` +
                `Erreur: ${error.message}\\n\\n` +
                `Les sessions WhatsApp restent actives.\\n` +
                `Le bot continue de fonctionner normalement.`
            );
            
            return { 
                success: false, 
                error: error.message,
                sessionsPreserved: true
            };
        } finally {
            this.isUpdating = false;
        }
    }

    getSessionsSnapshot() {
        const sessions = [];
        for (const [sessionId, sessionData] of this.sessionManager.sessions) {
            sessions.push({
                sessionId,
                userId: sessionData.userId,
                status: sessionData.status,
                connected: sessionData.status === 'connected'
            });
        }
        return sessions;
    }

    async verifySessionsIntegrity(before, after) {
        const beforeConnected = before.filter(s => s.connected).length;
        const afterConnected = after.filter(s => s.connected).length;
        
        log.update(this.currentVersion, `📊 Intégrité sessions: ${beforeConnected} → ${afterConnected} connectées`);
        
        if (afterConnected < beforeConnected) {
            log.warn(`⚠️  ${beforeConnected - afterConnected} sessions perdues pendant la mise à jour`);
        } else {
            log.success(`✅ Toutes les sessions préservées (${afterConnected} connectées)`);
        }
    }

    async backupCustomCommands() {
        try {
            log.update(this.currentVersion, '💾 Sauvegarde des commandes personnalisées...');
            
            const commandsDir = path.join(__dirname, '../custom-commands');
            const backupDir = path.join(__dirname, '../backups/commands-backup');
            
            if (fs.existsSync(commandsDir)) {
                await fs.ensureDir(backupDir);
                await fs.emptyDir(backupDir);
                await fs.copy(commandsDir, backupDir);
                log.update(this.currentVersion, '✅ Commandes personnalisées sauvegardées');
            }
            
        } catch (error) {
            log.error('❌ Erreur sauvegarde commandes:', error);
        }
    }

    async executeGitUpdate() {
        return new Promise((resolve, reject) => {
            log.update(this.currentVersion, '📥 Récupération des dernières modifications...');
            
            const commands = [
                'git fetch origin',
                `git reset --hard origin/${config.updates.branch}`,
                'git clean -fd'
            ];

            const executeNext = (index) => {
                if (index >= commands.length) {
                    resolve();
                    return;
                }

                log.update(this.currentVersion, `▶️  Exécution: ${commands[index]}`);
                
                exec(commands[index], { 
                    cwd: process.cwd(),
                    timeout: 60000
                }, (error, stdout, stderr) => {
                    if (error) {
                        log.error(`❌ Erreur commande Git: ${commands[index]}`, stderr);
                        reject(new Error(`Échec commande Git: ${commands[index]}\n${stderr}`));
                        return;
                    }

                    if (stdout) log.update(this.currentVersion, stdout);
                    if (stderr) log.update(this.currentVersion, `Stderr: ${stderr}`);
                    
                    executeNext(index + 1);
                });
            };

            executeNext(0);
        });
    }

    async updateDependencies() {
        return new Promise((resolve, reject) => {
            log.update(this.currentVersion, '📦 Vérification des dépendances...');
            
            exec('git diff --name-only HEAD~1 HEAD | grep package.json', (error, stdout) => {
                if (stdout.includes('package.json')) {
                    log.update(this.currentVersion, '🔄 Mise à jour des dépendances npm...');
                    
                    exec('npm install --production --no-audit --no-fund', { 
                        cwd: process.cwd(),
                        timeout: 120000
                    }, (error, stdout, stderr) => {
                        if (error) {
                            log.error('❌ Erreur installation dépendances:', stderr);
                            reject(new Error(`Échec installation dépendances: ${stderr}`));
                            return;
                        }
                        
                        log.update(this.currentVersion, '✅ Dépendances mises à jour');
                        resolve();
                    });
                } else {
                    log.update(this.currentVersion, '✅ Aucune modification des dépendances');
                    resolve();
                }
            });
        });
    }

    async reloadModulesDynamically() {
        try {
            log.update(this.currentVersion, '🔄 Rechargement dynamique des modules...');
            
            const safeModules = [
                './command-handler',
                './dynamic-command-manager', 
                './auth-manager',
                './resource-manager',
                './utils/logger'
            ];
            
            let reloadedCount = 0;
            
            for (const modulePath of safeModules) {
                try {
                    const fullPath = require.resolve(modulePath);
                    delete require.cache[fullPath];
                    require(modulePath);
                    reloadedCount++;
                    log.update(this.currentVersion, `✅ Module rechargé: ${modulePath}`);
                } catch (error) {
                    log.update(this.currentVersion, `⚠️  Module non rechargé: ${modulePath} - ${error.message}`);
                }
            }
            
            delete require.cache[require.resolve('./config')];
            const newConfig = require('./config');
            this.currentVersion = newConfig.bot.version;
            
            log.update(this.currentVersion, `✅ ${reloadedCount} modules rechargés dynamiquement`);
            
        } catch (error) {
            log.error('❌ Erreur rechargement modules:', error);
        }
    }

    async updateCommandsFromGitHub() {
        try {
            log.update(this.currentVersion, '📥 Mise à jour des commandes depuis GitHub...');
            
            const commandsUrl = `https://api.github.com/repos/${config.updates.github_repo}/contents/custom-commands`;
            
            try {
                const { data: files } = await axios.get(commandsUrl, { 
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'NOVA-MD-Bot'
                    }
                });
                
                let updatedCount = 0;
                const commandsDir = path.join(__dirname, '../custom-commands');
                await fs.ensureDir(commandsDir);
                
                for (const file of files) {
                    if (file.name.endsWith('.js') && file.type === 'file') {
                        try {
                            const { data: commandCode } = await axios.get(file.download_url, { timeout: 10000 });
                            const commandPath = path.join(commandsDir, file.name);
                            
                            await fs.writeFile(commandPath, commandCode, 'utf8');
                            updatedCount++;
                            
                            log.update(this.currentVersion, `✅ Commande téléchargée: ${file.name}`);
                        } catch (error) {
                            log.error(`❌ Erreur téléchargement ${file.name}:`, error.message);
                        }
                    }
                }
                
                if (this.sessionManager.commandManager) {
                    await this.sessionManager.commandManager.reloadAllCommands();
                }
                
                log.update(this.currentVersion, `✅ ${updatedCount} commandes mises à jour depuis GitHub`);
                return { success: true, updated: updatedCount };
            } catch (error) {
                if (error.response?.status === 404) {
                    log.update(this.currentVersion, 'ℹ️  Aucun dossier custom-commands sur GitHub');
                    return { success: true, updated: 0 };
                }
                throw error;
            }
        } catch (error) {
            log.error('❌ Erreur mise à jour commandes GitHub:', error);
            return { success: false, error: error.message };
        }
    }

    async forceUpdate() {
        log.update(this.currentVersion, '🔧 Forçage de la mise à jour...');
        return await this.performUpdate(true);
    }

    async notifyAdmins(message) {
        const adminIds = config.telegram.admin_ids;
        
        for (const adminId of adminIds) {
            try {
                await this.bot.sendMessage(adminId, message, { 
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                log.error(`❌ Erreur notification admin ${adminId}:`, error.message);
            }
        }
    }

    async getUpdateStatus() {
        const updateInfo = await this.checkForUpdates();
        
        return {
            currentVersion: this.currentVersion,
            currentHash: await this.getCurrentCommitHash(),
            isUpdating: this.isUpdating,
            lastCheck: this.lastCheck,
            ...updateInfo
        };
    }

    stopAutoUpdate() {
        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
            this.updateCheckInterval = null;
        }
    }
}

module.exports = UpdateManager;
