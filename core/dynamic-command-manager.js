const fs = require('fs-extra');
const path = require('path');
const vm = require('vm');
const axios = require('axios');
const config = require('./config');
const log = require('./utils/logger')(module);

class DynamicCommandManager {
    constructor() {
        this.commands = new Map();
        this.customCommandsPath = path.join(__dirname, '../custom-commands');
        this.loadedCommands = new Set();
        
        this.ensureCommandsDirectory();
        this.loadCustomCommands();
    }

    ensureCommandsDirectory() {
        if (!fs.existsSync(this.customCommandsPath)) {
            fs.mkdirSync(this.customCommandsPath, { recursive: true });
            log.info('📁 Dossier custom-commands créé');
        }
    }

    loadCustomCommands() {
        try {
            const files = fs.readdirSync(this.customCommandsPath);
            let loadedCount = 0;

            for (const file of files) {
                if (file.endsWith('.js')) {
                    try {
                        const commandPath = path.join(this.customCommandsPath, file);
                        const commandCode = fs.readFileSync(commandPath, 'utf8');
                        
                        this.loadCommandFromCode(commandCode, file);
                        loadedCount++;
                    } catch (error) {
                        log.error(`❌ Erreur chargement commande ${file}:`, error);
                    }
                }
            }

            log.success(`📁 ${loadedCount} commandes personnalisées chargées`);
        } catch (error) {
            log.error('❌ Erreur chargement commandes personnalisées:', error);
        }
    }

    async loadCommandsFromGitHub() {
        try {
            log.update('Chargement des commandes depuis GitHub...');
            
            const commandsUrl = `https://api.github.com/repos/${config.updates.github_repo}/contents/custom-commands`;
            const { data: files } = await axios.get(commandsUrl, { timeout: 10000 });
            
            let loadedCount = 0;
            
            for (const file of files) {
                if (file.name.endsWith('.js')) {
                    try {
                        const { data: commandCode } = await axios.get(file.download_url);
                        const result = this.loadCommandFromCode(commandCode, file.name);
                        
                        if (result.success) {
                            const localPath = path.join(this.customCommandsPath, file.name);
                            await fs.writeFile(localPath, commandCode);
                            loadedCount++;
                        }
                    } catch (error) {
                        log.error(`❌ Erreur chargement GitHub ${file.name}:`, error);
                    }
                }
            }
            
            log.success(`✅ ${loadedCount} commandes chargées depuis GitHub`);
            return { success: true, loaded: loadedCount };
        } catch (error) {
            log.error('❌ Erreur chargement commandes GitHub:', error);
            return { success: false, error: error.message };
        }
    }

    loadCommandFromCode(code, filename) {
        try {
            const context = {
                module: { exports: {} },
                require: require,
                console: console,
                process: process,
                __filename: filename,
                __dirname: this.customCommandsPath
            };

            vm.createContext(context);
            vm.runInContext(code, context, { 
                filename: filename,
                timeout: 5000
            });

            const command = context.module.exports;
            
            if (command && command.name && command.run) {
                this.commands.set(command.name, command);
                this.loadedCommands.add(command.name);
                
                if (command.aliases && Array.isArray(command.aliases)) {
                    command.aliases.forEach(alias => {
                        this.commands.set(alias, command);
                    });
                }

                log.success(`✅ Commande chargée: ${command.name}`);
                return { success: true, command: command.name };
            } else {
                throw new Error('Structure de commande invalide');
            }
        } catch (error) {
            log.error(`❌ Erreur chargement commande ${filename}:`, error);
            return { success: false, error: error.message };
        }
    }

    async createCommand(commandData) {
        try {
            const { name, code, description = '', category = 'custom', aliases = [] } = commandData;
            
            if (!name || !/^[a-z0-9_]+$/i.test(name)) {
                return { success: false, error: 'Nom de commande invalide' };
            }

            const commandObject = {
                name,
                description,
                category,
                aliases,
                run: async (context) => {
                    const sandbox = {
                        context,
                        bot: context.bot,
                        message: context.message,
                        authManager: context.authManager,
                        sessionManager: context.sessionManager,
                        updateManager: context.updateManager,
                        commandManager: context.commandManager,
                        require: require,
                        console: console
                    };

                    try {
                        vm.createContext(sandbox);
                        const result = vm.runInContext(code, sandbox, { timeout: 10000 });
                        return await Promise.resolve(result);
                    } catch (error) {
                        log.error(`❌ Erreur exécution commande ${name}:`, error);
                        await context.bot.sendMessage(
                            context.message.chat.id,
                            `❌ Erreur dans la commande ${name}: ${error.message}`
                        );
                    }
                }
            };

            const commandPath = path.join(this.customCommandsPath, `${name}.js`);
            const fileContent = this.generateCommandFile(commandObject);
            
            await fs.writeFile(commandPath, fileContent);
            
            this.commands.set(name, commandObject);
            aliases.forEach(alias => this.commands.set(alias, commandObject));
            
            log.success(`✅ Commande créée: ${name}`);
            return { success: true, command: name, path: commandPath };

        } catch (error) {
            log.error(`❌ Erreur création commande ${commandData.name}:`, error);
            return { success: false, error: error.message };
        }
    }

    generateCommandFile(command) {
        return `// Commande personnalisée: ${command.name}
// Catégorie: ${command.category}
// Description: ${command.description}
// Créée le: ${new Date().toISOString()}

module.exports = {
    name: "${command.name}",
    description: "${command.description}",
    category: "${command.category}",
    aliases: ${JSON.stringify(command.aliases)},
    
    run: ${command.run.toString()}
};
        `.trim();
    }

    getCommand(name) {
        return this.commands.get(name);
    }

    async executeCommand(commandName, context) {
        const command = this.getCommand(commandName);
        
        if (!command) {
            return { success: false, error: 'Commande non trouvée' };
        }

        try {
            await command.run(context);
            return { success: true };
        } catch (error) {
            log.error(`❌ Erreur exécution commande ${commandName}:`, error);
            return { success: false, error: error.message };
        }
    }

    getAllCommands() {
        const commands = [];
        const added = new Set();
        
        for (const [name, command] of this.commands) {
            if (!added.has(command.name) && this.loadedCommands.has(command.name)) {
                commands.push(command);
                added.add(command.name);
            }
        }
        
        return commands;
    }

    async deleteCommand(commandName) {
        try {
            const command = this.getCommand(commandName);
            if (!command) {
                return { success: false, error: 'Commande non trouvée' };
            }

            const commandPath = path.join(this.customCommandsPath, `${commandName}.js`);
            if (fs.existsSync(commandPath)) {
                await fs.remove(commandPath);
            }

            this.commands.delete(commandName);
            this.loadedCommands.delete(commandName);
            
            if (command.aliases) {
                command.aliases.forEach(alias => {
                    this.commands.delete(alias);
                });
            }

            log.success(`✅ Commande supprimée: ${commandName}`);
            return { success: true };

        } catch (error) {
            log.error(`❌ Erreur suppression commande ${commandName}:`, error);
            return { success: false, error: error.message };
        }
    }

    async reloadCommand(commandName) {
        try {
            const commandPath = path.join(this.customCommandsPath, `${commandName}.js`);
            
            if (!fs.existsSync(commandPath)) {
                return { success: false, error: 'Fichier commande non trouvé' };
            }

            const commandCode = await fs.readFile(commandPath, 'utf8');
            const result = this.loadCommandFromCode(commandCode, `${commandName}.js`);
            
            return result;

        } catch (error) {
            log.error(`❌ Erreur rechargement commande ${commandName}:`, error);
            return { success: false, error: error.message };
        }
    }

    async reloadAllCommands() {
        try {
            this.commands.clear();
            this.loadedCommands.clear();
            
            this.loadCustomCommands();
            
            log.success('🔄 Toutes les commandes personnalisées rechargées');
            return { success: true, count: this.loadedCommands.size };
        } catch (error) {
            log.error('❌ Erreur rechargement toutes les commandes:', error);
            return { success: false, error: error.message };
        }
    }

    getCommandStats() {
        const commands = this.getAllCommands();
        const categories = {};
        
        commands.forEach(command => {
            if (!categories[command.category]) {
                categories[command.category] = [];
            }
            categories[command.category].push(command);
        });
        
        return {
            total: commands.length,
            commands: commands.map(cmd => cmd.name),
            categories: categories
        };
    }

    getCommandsByCategory() {
        return this.getCommandStats().categories;
    }

    async syncWithGitHub() {
        try {
            log.update('🔄 Synchronisation des commandes avec GitHub...');
            
            const result = await this.loadCommandsFromGitHub();
            
            if (result.success) {
                await this.reloadAllCommands();
            }
            
            return result;
        } catch (error) {
            log.error('❌ Erreur synchronisation GitHub:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = DynamicCommandManager;