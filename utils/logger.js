const chalk = require('chalk');
const util = require('util');

function getTimestamp() {
    return `[${new Date().toLocaleTimeString('fr-FR')}]`;
}

function getCallerInfo() {
    const stack = new Error().stack.split('\n');
    if (stack.length > 4) {
        const callerLine = stack[4];
        const match = callerLine.match(/\(?(.+):(\d+):(\d+)\)?$/);
        if (match) {
            const filepath = match[1];
            const filename = filepath.split(/\\|\//).pop().replace('.js', '');
            return filename.toUpperCase();
        }
    }
    return 'NOVA-MD';
}

const logLevels = {
    ERROR: { color: chalk.red, prefix: '❌' },
    WARN: { color: chalk.yellow, prefix: '⚠️' },
    INFO: { color: chalk.blue, prefix: 'ℹ️' },
    SUCCESS: { color: chalk.green, prefix: '✅' },
    DEBUG: { color: chalk.gray, prefix: '🐛' },
    UPDATE: { color: chalk.magenta, prefix: '🔄' }
};

function formatMessage(level, ...args) {
    const levelConfig = logLevels[level] || logLevels.INFO;
    const timestamp = chalk.gray.italic(getTimestamp());
    const tag = chalk.cyan.bold(`[${getCallerInfo()}]`);
    const prefix = levelConfig.prefix;
    
    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            return util.inspect(arg, { 
                depth: 4, 
                colors: true,
                compact: true 
            });
        }
        return arg;
    }).join(' ');
    
    const coloredMessage = levelConfig.color(message);
    
    return `${timestamp} ${tag} ${prefix} ${coloredMessage}`;
}

module.exports = function (caller) {
    const callerName = caller?.filename ? 
        caller.filename.split(/\\|\//).pop().replace('.js', '').toUpperCase() : 'NOVA-MD';
    
    return {
        error: (...args) => console.error(formatMessage('ERROR', ...args)),
        warn: (...args) => console.warn(formatMessage('WARN', ...args)),
        info: (...args) => console.info(formatMessage('INFO', ...args)),
        success: (...args) => console.log(formatMessage('SUCCESS', ...args)),
        debug: (...args) => {
            if (process.env.DEBUG === 'true') {
                console.log(formatMessage('DEBUG', ...args));
            }
        },
        update: (...args) => console.log(formatMessage('UPDATE', ...args)),
        
        session: (sessionId, ...args) => {
            const sessionTag = chalk.magenta(`[SESSION:${sessionId.slice(-8)}]`);
            console.log(`${chalk.gray.italic(getTimestamp())} ${sessionTag} ${args.join(' ')}`);
        },
        
        user: (userId, ...args) => {
            const userTag = chalk.cyan(`[USER:${userId}]`);
            console.log(`${chalk.gray.italic(getTimestamp())} ${userTag} ${args.join(' ')}`);
        },
        
        command: (commandName, ...args) => {
            const commandTag = chalk.yellow(`[CMD:${commandName}]`);
            console.log(`${chalk.gray.italic(getTimestamp())} ${commandTag} ${args.join(' ')}`);
        }
    };
};

module.exports.error = (...args) => console.error(formatMessage('ERROR', ...args));
module.exports.warn = (...args) => console.warn(formatMessage('WARN', ...args));
module.exports.info = (...args) => console.info(formatMessage('INFO', ...args));
module.exports.success = (...args) => console.log(formatMessage('SUCCESS', ...args));
module.exports.update = (...args) => console.log(formatMessage('UPDATE', ...args));
module.exports.debug = (...args) => {
    if (process.env.DEBUG === 'true') {
        console.log(formatMessage('DEBUG', ...args));
    }
};
