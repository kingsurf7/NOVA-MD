const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger')(module);

class SimpleUpdateManager {
    constructor(bot, sessionManager) {
        this.bot = bot;
        this.sessionManager = sessionManager;
        this.isUpdating = false;
        this.currentVersion = config.bot.version;
        this.tempDir = path.join(__dirname, '../temp-update');
        this.backupDir = path.join(__dirname, '../backup');
    }

    async performUpdate(force = false) {
        if (this.isUpdating) {
            throw new Error('Mise à jour déjà en cours');
        }

        this.isUpdating = true;
        
        try {
            log.update('🚀 Début de la mise à jour simplifiée...');

            // 1. Sauvegarder les sessions et données importantes
            const sessionsBefore = this.getSessionsSnapshot();
            await this.backupEssentialData();

            // 2. Cloner la nouvelle version
            await this.cloneNewVersion();

            // 3. Copier les fichiers mis à jour
            await this.copyUpdatedFiles();

            // 4. Mettre à jour les dépendances
            await this.installDependencies();

            // 5. Vérifier l'intégrité
            const sessionsAfter = this.getSessionsSnapshot();
            await this.verifyUpdate();

            log.update('✅ Mise à jour terminée avec succès!');
            
            await this.notifyAdmins(
                `✅ *Mise à jour réussie!*\n\n` +
                `Méthode: Git Clone Simple\n` +
                `Sessions préservées: ${sessionsAfter.length}/${sessionsBefore.length}\n` +
                `Redémarrage: Recommandé`
            );

            return { 
                success: true, 
                method: 'git-clone',
                sessionsBefore: sessionsBefore.length,
                sessionsAfter: sessionsAfter.length,
                restartRecommended: true
            };

        } catch (error) {
            log.error('❌ Erreur mise à jour:', error);
            
            // Restaurer la backup en cas d'erreur
            await this.restoreBackup();
            
            await this.notifyAdmins(
                `❌ *Échec mise à jour*\n\n` +
                `Erreur: ${error.message}\n` +
                `Système restauré à la version précédente.`
            );
            
            return { 
                success: false, 
                error: error.message,
                restored: true
            };
        } finally {
            this.isUpdating = false;
            await this.cleanup();
        }
    }

    async cloneNewVersion() {
        return new Promise((resolve, reject) => {
            log.update('📥 Clonage de la nouvelle version...');

            // Nettoyer le dossier temporaire
            exec(`rm -rf ${this.tempDir}`, async () => {
                const repoUrl = `https://github.com/${config.updates.github_repo}.git`;
                
                exec(`git clone ${repoUrl} ${this.tempDir} --depth 1 --branch ${config.updates.branch}`, 
                { timeout: 120000 }, (error, stdout, stderr) => {
                    if (error) {
                        log.error('❌ Erreur clonage:', stderr);
                        reject(new Error(`Échec clonage: ${stderr}`));
                        return;
                    }

                    log.update('✅ Nouvelle version clonée');
                    resolve();
                });
            });
        });
    }

    async backupEssentialData() {
        try {
            log.update('💾 Sauvegarde des données essentielles...');
            
            await fs.ensureDir(this.backupDir);
            await fs.emptyDir(this.backupDir);

            // Sauvegarder les dossiers critiques
            const essentialFolders = [
                'sessions',
                'custom-commands', 
                'backups',
                'logs'
            ];

            for (const folder of essentialFolders) {
                const source = path.join(process.cwd(), folder);
                const target = path.join(this.backupDir, folder);
                
                if (await fs.pathExists(source)) {
                    await fs.copy(source, target);
                    log.update(`✅ ${folder} sauvegardé`);
                }
            }

            // Sauvegarder le .env
            const envPath = path.join(process.cwd(), '.env');
            if (await fs.pathExists(envPath)) {
                await fs.copy(envPath, path.join(this.backupDir, '.env'));
            }

            log.update('✅ Sauvegarde terminée');

        } catch (error) {
            log.error('❌ Erreur sauvegarde:', error);
            throw error;
        }
    }

    async copyUpdatedFiles() {
        try {
            log.update('📁 Copie des fichiers mis à jour...');

            const sourceDir = this.tempDir;
            const targetDir = process.cwd();

            // Liste des fichiers/dossiers à exclure de la copie
            const excludeList = [
                'sessions',
                'custom-commands',
                'backups', 
                'logs',
                'node_modules',
                '.env',
                '.git'
            ];

            // Obtenir tous les fichiers du nouveau clone
            const allFiles = await fs.readdir(sourceDir);
            
            for (const file of allFiles) {
                if (excludeList.includes(file)) {
                    continue; // Ignorer les dossiers exclus
                }

                const sourcePath = path.join(sourceDir, file);
                const targetPath = path.join(targetDir, file);

                try {
                    // Supprimer l'ancienne version si elle existe
                    if (await fs.pathExists(targetPath)) {
                        await fs.remove(targetPath);
                    }

                    // Copier la nouvelle version
                    await fs.copy(sourcePath, targetPath);
                    log.update(`✅ ${file} mis à jour`);

                } catch (error) {
                    log.warn(`⚠️  Impossible de mettre à jour ${file}: ${error.message}`);
                }
            }

            // Restaurer les données sauvegardées
            await this.restoreEssentialData();

            log.update('✅ Copie des fichiers terminée');

        } catch (error) {
            log.error('❌ Erreur copie fichiers:', error);
            throw error;
        }
    }

    async restoreEssentialData() {
        try {
            log.update('🔄 Restauration des données essentielles...');

            // Restaurer les dossiers sauvegardés
            const essentialFolders = [
                'sessions',
                'custom-commands',
                'backups',
                'logs'
            ];

            for (const folder of essentialFolders) {
                const source = path.join(this.backupDir, folder);
                const target = path.join(process.cwd(), folder);
                
                if (await fs.pathExists(source)) {
                    await fs.copy(source, target);
                    log.update(`✅ ${folder} restauré`);
                }
            }

            // Restaurer le .env
            const envBackup = path.join(this.backupDir, '.env');
            const envTarget = path.join(process.cwd(), '.env');
            if (await fs.pathExists(envBackup) && !await fs.pathExists(envTarget)) {
                await fs.copy(envBackup, envTarget);
            }

            log.update('✅ Données essentielles restaurées');

        } catch (error) {
            log.error('❌ Erreur restauration données:', error);
            throw error;
        }
    }

    async installDependencies() {
        return new Promise((resolve, reject) => {
            log.update('📦 Installation des dépendances...');

            exec('npm install --production --no-audit --no-fund', 
            { 
                cwd: process.cwd(),
                timeout: 120000 
            }, (error, stdout, stderr) => {
                if (error) {
                    log.error('❌ Erreur installation dépendances:', stderr);
                    reject(new Error(`Échec installation: ${stderr}`));
                    return;
                }
                
                log.update('✅ Dépendances installées');
                resolve();
            });
        });
    }

    async restoreBackup() {
        try {
            log.update('🔄 Restauration depuis la sauvegarde...');

            if (!await fs.pathExists(this.backupDir)) {
                log.warn('⚠️  Aucune sauvegarde trouvée');
                return;
            }

            await this.restoreEssentialData();
            log.update('✅ Système restauré depuis sauvegarde');

        } catch (error) {
            log.error('❌ Erreur restauration backup:', error);
        }
    }

    async verifyUpdate() {
        try {
            log.update('🔍 Vérification de la mise à jour...');

            // Vérifier que les fichiers essentiels existent
            const essentialFiles = [
                'index.js',
                'package.json',
                'config.js'
            ];

            for (const file of essentialFiles) {
                if (!await fs.pathExists(path.join(process.cwd(), file))) {
                    throw new Error(`Fichier manquant après mise à jour: ${file}`);
                }
            }

            // Vérifier la nouvelle version
            const newPackage = require(path.join(process.cwd(), 'package.json'));
            log.update(`✅ Version mise à jour: ${newPackage.version}`);

            return { success: true, newVersion: newPackage.version };

        } catch (error) {
            log.error('❌ Erreur vérification mise à jour:', error);
            throw error;
        }
    }

    getSessionsSnapshot() {
        const sessions = [];
        if (this.sessionManager && this.sessionManager.sessions) {
            for (const [sessionId, sessionData] of this.sessionManager.sessions) {
                sessions.push({
                    sessionId,
                    userId: sessionData.userId,
                    status: sessionData.status
                });
            }
        }
        return sessions;
    }

    async notifyAdmins(message) {
        if (!this.bot) return;

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

    async cleanup() {
        try {
            // Nettoyer le dossier temporaire
            if (await fs.pathExists(this.tempDir)) {
                await fs.remove(this.tempDir);
            }
            
            log.update('🧹 Nettoyage terminé');
        } catch (error) {
            log.error('❌ Erreur nettoyage:', error);
        }
    }

    async checkForUpdates() {
        return new Promise((resolve) => {
            log.update('🔍 Vérification des mises à jour...');
            
            exec('git ls-remote origin HEAD', { timeout: 10000 }, (error, stdout) => {
                if (error) {
                    resolve({ available: false, error: error.message });
                    return;
                }

                const remoteHash = stdout.split('\t')[0];
                
                exec('git rev-parse HEAD', (error, localHash) => {
                    if (error) {
                        resolve({ available: false, error: error.message });
                        return;
                    }

                    const available = remoteHash.trim() !== localHash.trim();
                    
                    resolve({
                        available: available,
                        currentHash: localHash.trim().substring(0, 8),
                        latestHash: remoteHash.trim().substring(0, 8),
                        currentVersion: this.currentVersion
                    });
                });
            });
        });
    }
}

module.exports = SimpleUpdateManager;
